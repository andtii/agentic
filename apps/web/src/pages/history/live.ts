/**
 * The live history page's view model (#146, OPS-03): pure adapters from
 * what the Audit actor returns — `Audit.list(query)`, newest first, paged
 * by `seq` — to the rows the mock page draws (time, kind tag, actor, what
 * happened, ref), plus the page's filters as the actor's query. Nothing
 * here touches a hook or the DOM.
 */
import type { AuditEvent, AuditKind, AuditQuery } from '@agentic/platform';
import type { AgentHue, Tone } from '@agentic/ui';
import type { AgentLookup } from '../chat/live';
import { isResumeWait } from '../../components/status';

/** The artboard's column template (`docs/design/HANDOFF.md` → tables) — the mock page's and the live page's. */
export const HISTORY_COLS = '84px 150px 130px 1fr 110px';

/** The kind chips: each names the audit kinds it keeps (`all` keeps every kind). */
export const HISTORY_KIND_FILTERS = [
    { id: 'all', label: 'All', kinds: undefined },
    { id: 'approvals', label: 'Approvals', kinds: ['approval.requested', 'approval.resolved'] },
    { id: 'delegations', label: 'Delegations', kinds: ['delegation.created'] },
    { id: 'environments', label: 'Environments and folders', kinds: ['environment.chosen', 'workdir.worktree-created'] },
    { id: 'transitions', label: 'Transitions', kinds: ['task.transition'] },
    { id: 'config', label: 'Config changes', kinds: ['config.versioned', 'proposal.reviewed'] },
    { id: 'machines', label: 'Machines', kinds: ['machine.paired', 'machine.revoked', 'environment.put', 'environment.removed', 'machine.update-requested', 'machine.updated', 'machine.update-failed', 'machine.channel-set', 'machine.update-policy-set', 'harness.changed'] },
    { id: 'plugins', label: 'Plugins and secrets', kinds: ['plugin.enabled', 'plugin.disabled', 'plugin.activated', 'plugin.granted', 'secret.opened'] },
    { id: 'connectors', label: 'Connected accounts', kinds: ['connector.connected', 'connector.needs-reauth', 'connector.disconnected'] }
] as const satisfies readonly { id: string; label: string; kinds?: readonly AuditKind[] }[];

export type HistoryKindFilter = (typeof HISTORY_KIND_FILTERS)[number]['id'];

/** The time window chips: how far back `since` reaches from now. */
export const HISTORY_WINDOWS = [
    { id: 'all', label: 'Any time', ms: null },
    { id: 'hour', label: 'Last hour', ms: 60 * 60_000 },
    { id: 'day', label: 'Last 24 h', ms: 24 * 60 * 60_000 },
    { id: 'week', label: 'Last 7 days', ms: 7 * 24 * 60 * 60_000 }
] as const satisfies readonly { id: string; label: string; ms: number | null }[];

export type HistoryWindow = (typeof HISTORY_WINDOWS)[number]['id'];

/** Everything the page filters on. */
export interface HistoryFilters {
    readonly kind: HistoryKindFilter;
    /** An agent id, or `null` for every actor. */
    readonly agentId: string | null;
    readonly window: HistoryWindow;
}

export const DEFAULT_FILTERS: HistoryFilters = { kind: 'all', agentId: null, window: 'all' };

/** How many events a page holds. */
export const HISTORY_PAGE = 50;

/** The filters as the actor's query; `cursor` is the previous page's `next`. */
export function auditQueryOf(filters: HistoryFilters, now: number, cursor: number | null = null): AuditQuery {
    const spec = HISTORY_KIND_FILTERS.find((f) => f.id === filters.kind);
    const win = HISTORY_WINDOWS.find((w) => w.id === filters.window);
    return {
        ...(spec?.kinds ? { kinds: spec.kinds } : {}),
        ...(filters.agentId ? { agentId: filters.agentId } : {}),
        ...(win?.ms ? { since: now - win.ms } : {}),
        ...(cursor !== null ? { cursor } : {}),
        limit: HISTORY_PAGE
    };
}

/** A kind's tag tone: what waits on a person is amber, what broke is red, what was learned or granted is live, the rest neutral. An environment change's tone follows its outcome (`toneOf`). */
export const KIND_TONE: Partial<Record<AuditKind, Tone>> = {
    'approval.requested': 'needs-you',
    'proposal.reviewed': 'live',
    'plugin.granted': 'live',
    'plugin.activated': 'live',
    'machine.paired': 'live',
    'machine.revoked': 'failed',
    'machine.updated': 'live',
    'machine.update-failed': 'failed',
    'machine.update-requested': 'working',
    'workdir.worktree-created': 'live',
    'secret.opened': 'needs-you',
    'connector.connected': 'live',
    'connector.needs-reauth': 'failed'
};

/** The audit kinds of a daemon update and its settings (#365); each row leads to its machine. */
const MACHINE_UPDATE_KINDS: ReadonlySet<AuditKind> = new Set<AuditKind>(['machine.update-requested', 'machine.updated', 'machine.update-failed', 'machine.channel-set', 'machine.update-policy-set']);

/** The kind as the tag prints it: `approval requested`; a transition that parked the work as interrupted says so. */
export function kindLabel(e: AuditEvent): string {
    if (e.kind === 'task.transition') {
        if (isResumeWait(e.data.wait)) return 'interrupted';
        return e.data.to === 'failed' ? 'failed' : e.data.to === 'cancelled' ? 'cancelled' : 'transition';
    }
    if (e.kind === 'workdir.worktree-created') return 'worktree created';
    // A connected account (#532, #533): `connected`, `reconnected`, `needs reconnecting`, `disconnected`.
    if (e.kind === 'connector.connected') return e.data.reconnected ? 'reconnected' : 'connected';
    if (e.kind === 'connector.needs-reauth') return 'needs reconnecting';
    if (e.kind === 'connector.disconnected') return 'disconnected';
    // A daemon update (#367): `update requested`, `updated`, `channel set`…
    if (MACHINE_UPDATE_KINDS.has(e.kind)) return e.kind.slice('machine.'.length).replace(/-/g, ' ');
    // A runtime's harness (#370): `harness installed`, `harness updated`, `harness removed`, or `harness failed`.
    if (e.kind === 'harness.changed') return e.data.outcome === 'done' ? `harness ${e.data.op === 'install' ? 'installed' : e.data.op === 'update' ? 'updated' : 'removed'}` : 'harness failed';
    return e.kind.replace('.', ' ');
}

/** The tag's tone for one event: transitions colour by where they went. */
export function toneOf(e: AuditEvent): Tone | undefined {
    if (e.kind === 'task.transition') {
        if (isResumeWait(e.data.wait)) return 'failed';
        if (e.data.to === 'failed') return 'failed';
        if (e.data.to === 'waiting') return 'needs-you';
        return undefined;
    }
    if (e.kind === 'environment.put' || e.kind === 'environment.removed') return e.data.outcome === 'ok' ? 'live' : 'failed';
    if (e.kind === 'harness.changed') return e.data.outcome === 'done' ? 'live' : 'failed';
    return KIND_TONE[e.kind];
}

export interface HistoryActor {
    readonly name: string;
    readonly hue: AgentHue;
    /** A person (`user:`) — drawn as a circle. */
    readonly person: boolean;
}

/**
 * Who acted: `user:<id>` (or the pages' bare `user`) is "You", `agent:<id>`
 * the directory's identity, a machine, a task or a system by its name.
 */
export function actorOf(by: string, lookup: AgentLookup): HistoryActor {
    const i = by.indexOf(':');
    const kind = i < 0 ? by : by.slice(0, i);
    const id = i < 0 ? by : by.slice(i + 1);
    switch (kind) {
        case 'user':
            return { name: 'You', hue: 1, person: true };
        case 'task':
            return { name: `task ${id}`, hue: 4, person: false };
        case 'agent': {
            const a = lookup(id);
            return { name: a.name, hue: a.hue, person: false };
        }
        case 'machine':
            return { name: id, hue: 3, person: false };
        case 'system':
            return { name: id === 'routing' ? 'platform' : id, hue: 4, person: false };
        default:
            return { name: by, hue: 2, person: false };
    }
}

export interface HistoryRef {
    readonly label: string;
    readonly href: string;
}

/** Where a row leads: its task, else its session, else its agent; a delegation leads to the child task. */
export function refOf(e: AuditEvent): HistoryRef | null {
    if (e.kind === 'delegation.created') return { label: e.data.childTaskId, href: `/tasks/${e.data.childTaskId}` };
    if (e.kind === 'machine.paired' || e.kind === 'machine.revoked') return { label: e.data.name, href: `/machines/${e.data.machineId}` };
    if (e.kind === 'environment.put') return { label: e.data.name, href: `/machines/${e.data.machineId}` };
    if (e.kind === 'environment.removed') return { label: e.data.environmentId, href: `/machines/${e.data.machineId}` };
    if (e.kind === 'workdir.worktree-created') return { label: e.data.branch, href: `/machines/${e.data.machineId}` };
    if (e.kind === 'harness.changed') return { label: e.data.runtime, href: `/machines/${e.data.machineId}#runtimes` };
    if (e.kind === 'machine.update-requested' || e.kind === 'machine.updated' || e.kind === 'machine.update-failed' || e.kind === 'machine.channel-set' || e.kind === 'machine.update-policy-set') return { label: e.data.machineId, href: `/machines/${e.data.machineId}` };
    // A conduit connector's plugin has the connector's id (`gmail`, #533): its page is where the account is.
    if (e.kind === 'connector.connected' || e.kind === 'connector.needs-reauth' || e.kind === 'connector.disconnected') return { label: e.data.displayName ?? e.data.accountId, href: `/plugins/${encodeURIComponent(e.data.connector)}` };
    if (e.taskId) return { label: e.taskId, href: `/tasks/${e.taskId}` };
    if (e.sessionId) return { label: e.sessionId, href: `/sessions/${e.sessionId}` };
    if (e.agentId) return { label: e.agentId, href: `/agents/${e.agentId}` };
    return null;
}

/** An ISO-shaped local time (`yyyy-mm-ddThh:mm:ss`) in `timeZone`, the form the ops formatters slice. */
export function localIso(at: number, timeZone?: string): string {
    const parts: Record<string, string> = {};
    try {
        for (const p of new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(at))) parts[p.type] = p.value;
    } catch {
        return new Date(at).toISOString().slice(0, 19);
    }
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

/** One row as the table draws it. */
export interface HistoryLiveRow {
    readonly id: string;
    readonly seq: number;
    readonly kind: AuditKind;
    readonly label: string;
    readonly tone: Tone | undefined;
    /** `yyyy-mm-ddThh:mm:ss` in the workspace zone. */
    readonly at: string;
    readonly actor: HistoryActor;
    readonly what: string;
    readonly ref: HistoryRef | null;
}

export function rowOf(e: AuditEvent, lookup: AgentLookup, timeZone?: string): HistoryLiveRow {
    return { id: e.key, seq: e.seq, kind: e.kind, label: kindLabel(e), tone: toneOf(e), at: localIso(e.at, timeZone), actor: actorOf(e.by, lookup), what: e.summary, ref: refOf(e) };
}

/** The pages read so far as one list, newest first, an event never twice (a live first page can overlap the second). */
export function mergePages(pages: readonly (readonly AuditEvent[])[]): AuditEvent[] {
    const seen = new Set<string>();
    const out: AuditEvent[] = [];
    for (const page of pages) {
        for (const e of page) {
            if (seen.has(e.key)) continue;
            seen.add(e.key);
            out.push(e);
        }
    }
    return out.sort((a, b) => b.seq - a.seq);
}
