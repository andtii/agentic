/**
 * The Audit actor (architecture §4 Audit; OPS-03, COL-09, AGT-06): the
 * inspectable record of every consequential action — approvals,
 * delegations, environment choices, task transitions, config changes,
 * machine pairing, plugin permissions, secret access.
 *
 * One definition, two keys. `{ws}:audit` is the LIVE log: `record(event)`
 * folds an event once by its `key` and stamps it with the next `seq`;
 * `list(query)` is the history page's live read, newest first, paged by
 * `seq` as the cursor. The live window is capped: once it holds
 * `AUDIT_WINDOW + AUDIT_ROLL_BATCH` events the oldest batch rolls over into
 * `{ws}:audit:{yyyy-mm}` archives (one per UTC month of the event's `at`)
 * through an idempotent `archive` hop, so a workspace's history never
 * rewrites one ever-growing record and a month can be retained or dropped
 * as a unit; `list` walks the archives when a cursor passes the window.
 *
 * Every mutation is one `AuditEntry` folded by `applyAuditEntry` and made
 * durable inside the turn (Workers never run `onDeactivate`).
 */

import { defineActor, type ActorContext, type ActorDefinition, type ActorOptions, type ActorPolicy } from '@sigx/actors';
import type { Principal } from '@agentic/core';
import { sameWorkspace } from '../auth/index.js';
import { type AuditEvent, type AuditEventInput, type AuditKind, assertAuditEvent } from './events.js';
import { AUDIT_TYPE, auditMonth, auditMonthKey, parseAuditKey } from './key.js';
import { applyAuditEntry, initialAuditState, type AuditEntry, type AuditState } from './state.js';

/** How many events the live log keeps before the oldest roll over. */
export const AUDIT_WINDOW = 500;
/** How many events roll over at a time. */
export const AUDIT_ROLL_BATCH = 100;
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;

export interface AuditQuery {
    /** Only these kinds; default all. */
    readonly kinds?: readonly AuditKind[];
    readonly agentId?: string;
    /** Events of this task — a `delegation.created` matches its child too. */
    readonly taskId?: string;
    readonly sessionId?: string;
    /** Inclusive lower bound on `at`. */
    readonly since?: number;
    /** Exclusive upper bound on `at`. */
    readonly until?: number;
    /** Exclusive: only events with a lower `seq` — the `next` of the previous page. `null` / absent starts at the newest. */
    readonly cursor?: number | null;
    /** Default `DEFAULT_LIST_LIMIT`, at most `MAX_LIST_LIMIT`. */
    readonly limit?: number;
}

export interface AuditPage {
    /** Newest first. */
    readonly events: readonly AuditEvent[];
    /** The cursor for the next page, or `null` when nothing older can match. */
    readonly next: number | null;
}

/** A type alias, not an interface: `ActorMethodTable` needs the implicit index signature only aliases carry. */
export type AuditMethods = {
    /** Record one occurrence on the live log. Idempotent by `event.key`; resolves `true` when the event was new. */
    record(event: AuditEventInput): Promise<boolean>;
    /** The history, newest first, filtered and paged. A live read: `useActorState(AuditActor, auditKey(ws)).list(q)` re-runs after every record. */
    list(query?: AuditQuery): Promise<AuditPage>;
    /** Archive key only — the live log's rollover hop. Idempotent by event key; resolves the number added. */
    archive(events: readonly AuditEvent[]): Promise<number>;
    /** How many events the log at this key holds in state, and — on the live key — ever recorded and archived. */
    stats(): { readonly inState: number; readonly recorded: number; readonly archived: number; readonly months: readonly string[] };
};

type Ctx = ActorContext<AuditState>;

/** Make one entry durable: `ctx.append` (@sigx/actors #312) where the runtime has it, the reducer plus a full `ctx.save()` otherwise. */
async function commit(ctx: Ctx, entry: AuditEntry): Promise<void> {
    const append = (ctx as Partial<{ append(entry: unknown): Promise<void> }>).append;
    if (typeof append === 'function') {
        await append.call(ctx, entry);
        return;
    }
    applyAuditEntry(ctx.state, entry);
    await ctx.save();
}

const clampLimit = (limit: number | undefined): number => Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(limit ?? DEFAULT_LIST_LIMIT) || DEFAULT_LIST_LIMIT));

function matcher(query: AuditQuery): (e: AuditEvent) => boolean {
    const kinds = query.kinds ? new Set<string>(query.kinds) : null;
    return (e) => {
        if (kinds && !kinds.has(e.kind)) return false;
        if (query.agentId !== undefined && e.agentId !== query.agentId) return false;
        if (query.sessionId !== undefined && e.sessionId !== query.sessionId) return false;
        if (query.taskId !== undefined && e.taskId !== query.taskId && !(e.kind === 'delegation.created' && e.data.childTaskId === query.taskId)) return false;
        if (query.since !== undefined && e.at < query.since) return false;
        if (query.until !== undefined && e.at >= query.until) return false;
        return true;
    };
}

/** Over the wire only a user records; the rollover hop reaches `archive` through `ctx.actor`, which runs no policy. */
const userOnly: ActorPolicy = (principal: Principal | null) => principal?.kind === 'user';
const never: ActorPolicy = () => false;

const options: ActorOptions<AuditState, AuditMethods, Record<never, never>> & { applyEntry(state: AuditState, entry: unknown): void } = {
    type: AUDIT_TYPE,
    authorize: [sameWorkspace],
    methodAuthorize: { record: userOnly, archive: never },
    state: initialAuditState,
    applyEntry: applyAuditEntry,
    reads: { list: { maxAge: 0 }, stats: { maxAge: 0 } },
    methodReentrancy: { list: 'always', stats: 'always' },
    methods: (ctx): AuditMethods => {
        const s = ctx.state;
        const ids = (): NonNullable<ReturnType<typeof parseAuditKey>> => {
            const parsed = parseAuditKey(ctx.key);
            if (!parsed) throw new Error(`audit: not an audit key: ${ctx.key}`);
            return parsed;
        };

        /** Roll the oldest batch(es) into their month archives while the window is over its cap. Idempotent: a crash between the hop and the save repeats it next time. */
        async function roll(): Promise<void> {
            const { workspaceId } = ids();
            while (s.events.length >= AUDIT_WINDOW + AUDIT_ROLL_BATCH) {
                const batch = ctx.snapshot(s.events.slice(0, AUDIT_ROLL_BATCH));
                const byMonth = new Map<string, AuditEvent[]>();
                for (const ev of batch) {
                    const m = auditMonth(ev.at);
                    (byMonth.get(m) ?? byMonth.set(m, []).get(m)!).push(ev);
                }
                for (const [month, events] of byMonth) await ctx.actor(AuditActor, auditMonthKey(workspaceId, month)).archive(events);
                await commit(ctx, { t: 'rolled', count: batch.length, months: [...byMonth.keys()] });
            }
        }

        return {
            async record(event) {
                const { month } = ids();
                if (month !== undefined) throw new Error(`audit ${ctx.key}: record on the live log, not an archive`);
                assertAuditEvent(event);
                if (Object.hasOwn(s.seen, event.key)) return false;
                await commit(ctx, { t: 'record', event });
                try {
                    await roll();
                } catch {
                    // An archive that cannot be reached leaves the window a little longer; the next record tries again.
                }
                return true;
            },

            async list(query = {}) {
                const { workspaceId } = ids();
                const limit = clampLimit(query.limit);
                const matches = matcher(query);
                const snap = ctx.snapshot();
                const cursor = query.cursor ?? null;
                const out: AuditEvent[] = [];
                // What this key holds, newest first: the live window, or (on an archive) the month's slice — ascending in `seq` either way.
                for (let i = snap.events.length - 1; i >= 0 && out.length < limit; i--) {
                    const ev = snap.events[i]!;
                    if (cursor !== null && ev.seq >= cursor) continue;
                    if (matches(ev)) out.push(ev);
                }
                // The archives, newest month first, only below the window (a rollover in flight may hold an event in both).
                const bound = Math.min(cursor ?? snap.windowFrom, snap.windowFrom);
                const newest = query.until !== undefined ? auditMonth(query.until) : null;
                const oldest = query.since !== undefined ? auditMonth(query.since) : null;
                for (let m = snap.months.length - 1; m >= 0 && out.length < limit && bound > 0; m--) {
                    const month = snap.months[m]!;
                    if (newest !== null && month > newest) continue;
                    if (oldest !== null && month < oldest) break;
                    const page = await ctx.actor(AuditActor, auditMonthKey(workspaceId, month)).list({ ...query, cursor: bound, limit: limit - out.length });
                    out.push(...page.events);
                }
                return { events: out, next: out.length >= limit ? out[out.length - 1]!.seq : null };
            },

            async archive(events) {
                const { month } = ids();
                if (month === undefined) throw new Error(`audit ${ctx.key}: archive on a month key, not the live log`);
                let added = 0;
                for (const ev of events) if (!Object.hasOwn(s.seen, ev.key)) added++;
                if (added > 0) await commit(ctx, { t: 'archive', events });
                return added;
            },

            stats() {
                return { inState: s.events.length, recorded: s.seq, archived: s.windowFrom, months: ctx.snapshot(s.months) };
            }
        };
    }
};

export const AuditActor: ActorDefinition<AuditState, AuditMethods, Record<never, never>> = defineActor(options);
