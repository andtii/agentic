/**
 * Incoming Gmail as a polling trigger (#535, architecture §9 "connectors that
 * sign in"). One call is one poll of one connected account; the platform's
 * Schedule decides when, keeps the cursor between polls and turns each
 * arrival into a task for the chosen agent.
 *
 * conduit's Gmail spec declares a `new-email` poll trigger, but conduit 0.1
 * has no runtime that runs one ("triggers are delivered, not executed") and
 * the spec has no history operation. So a poll is the spec's own
 * `search-messages` bounded by `after:` — with the window overlapping the
 * previous poll, since Gmail's search index can lag a message's arrival — plus
 * a bounded set of the ids already delivered, and one `get-message` per
 * arrival for its From, Subject and snippet. Upstream gaps noted for
 * aigntiq/conduit: a poll-trigger runtime, and a `history.list` operation
 * (Gmail's own "since historyId" feed) for the spec.
 *
 * `after:` compares a message's internal (received) date, so a message that
 * starts matching the query later — labelled or marked unread after it
 * arrived — is not news to this trigger.
 */

import { ConduitAuthError, ConduitRequestError } from '@aigntiq/conduit';
import type { ConnectorEngine } from '../engine.js';
import { connectorToolName } from '../tools.js';

/** One new message, as the agent is told about it. Everything but the ids is what Gmail said, possibly absent. */
export interface GmailArrival {
    readonly id: string;
    readonly threadId: string;
    readonly from?: string;
    readonly subject?: string;
    readonly snippet?: string;
    /** ISO 8601. */
    readonly receivedAt?: string;
}

export interface GmailPollOptions {
    /** The conduit account the connector record names. */
    readonly account: string;
    /** The account's owner key (the workspace). */
    readonly owner: string;
    /** The conduit connector id. Default `gmail`. */
    readonly connector?: string;
    /** The owner's filter, in Gmail search syntax. Empty or absent: every message. */
    readonly query?: string;
    /** What the previous poll returned; absent on the first. */
    readonly cursor?: string;
    /** Epoch ms of this poll. */
    readonly now: number;
    /** How far back the FIRST poll looks. Default 15 minutes: news is what arrived around the time the trigger was switched on. */
    readonly firstLookbackMs?: number;
    /** Arrivals per poll, oldest first; the rest wait for the next poll. Default 20. */
    readonly maxArrivals?: number;
    readonly signal?: AbortSignal;
}

export type GmailPoll =
    | { readonly kind: 'arrivals'; readonly arrivals: readonly GmailArrival[]; readonly cursor: string }
    /** The account's sign-in expired or was revoked: nothing can be read until the owner reconnects. */
    | { readonly kind: 'needs-reauth'; readonly message: string };

/** The seconds each window reaches back before the previous poll, for messages Gmail indexes late. */
export const GMAIL_POLL_OVERLAP_SEC = 600;
/** Ids remembered as delivered: far more than one overlap window holds. */
export const GMAIL_SEEN_MAX = 500;
const DEFAULT_LOOKBACK_MS = 15 * 60_000;
const DEFAULT_MAX_ARRIVALS = 20;
/** Search pages per poll (100 messages each). */
const SEARCH_PAGES = 2;

interface Cursor {
    /** Epoch seconds: the window starts `GMAIL_POLL_OVERLAP_SEC` before it. */
    readonly since: number;
    /** Delivered ids, newest first. */
    readonly seen: readonly string[];
}

/** The cursor a poll stored, or `undefined` for anything this version did not write. */
export function parseGmailCursor(cursor: string | undefined): Cursor | undefined {
    if (!cursor) return undefined;
    try {
        const c = JSON.parse(cursor) as { v?: unknown; since?: unknown; seen?: unknown };
        if (c.v !== 1 || typeof c.since !== 'number' || !Number.isFinite(c.since) || !Array.isArray(c.seen)) return undefined;
        return { since: c.since, seen: c.seen.filter((x): x is string => typeof x === 'string') };
    } catch {
        return undefined;
    }
}

const writeCursor = (c: Cursor): string => JSON.stringify({ v: 1, since: c.since, seen: c.seen.slice(0, GMAIL_SEEN_MAX) });

const needsReauth = (e: unknown): e is ConduitAuthError => e instanceof ConduitAuthError && e.needsReauth;

/** The search the poll runs: the owner's filter, grouped, then the time bound. */
function searchQuery(query: string | undefined, after: number): string {
    const q = query?.trim();
    return q ? `(${q}) after:${after}` : `after:${after}`;
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** One poll. Throws only for a failure worth retrying (network, Gmail down); an account that needs reconnecting is a verdict. */
export async function pollGmail(engine: ConnectorEngine, options: GmailPollOptions): Promise<GmailPoll> {
    const connector = options.connector ?? 'gmail';
    const { account, owner, signal } = options;
    const nowSec = Math.floor(options.now / 1000);
    const previous = parseGmailCursor(options.cursor);
    const since = previous?.since ?? Math.floor((options.now - (options.firstLookbackMs ?? DEFAULT_LOOKBACK_MS)) / 1000);
    const after = previous ? since - GMAIL_POLL_OVERLAP_SEC : since;
    const seen = new Set(previous?.seen ?? []);
    const max = Math.max(1, options.maxArrivals ?? DEFAULT_MAX_ARRIVALS);

    try {
        const found = await engine.execute({ connector, operation: 'search-messages', account, owner, inputs: { query: searchQuery(options.query, after), maxPages: SEARCH_PAGES }, ...(signal ? { signal } : {}) });
        const hits = (Array.isArray(found.output) ? found.output : []) as { id?: unknown; threadId?: unknown }[];
        // Gmail answers newest first; news is delivered oldest first.
        const fresh = hits
            .filter((m): m is { id: string; threadId: unknown } => typeof m.id === 'string' && !seen.has(m.id))
            .reverse();
        const taken = fresh.slice(0, max);
        const arrivals: GmailArrival[] = [];
        for (const m of taken) {
            const threadId = typeof m.threadId === 'string' ? m.threadId : '';
            try {
                const got = await engine.execute({ connector, operation: 'get-message', account, owner, inputs: { id: m.id }, ...(signal ? { signal } : {}) });
                const o = (got.output ?? {}) as Record<string, unknown>;
                const from = text(o.from);
                const subject = text(o.subject);
                const snippet = text(o.snippet);
                const receivedAt = text(o.receivedAt);
                arrivals.push({ id: m.id, threadId: text(o.threadId) ?? threadId, ...(from ? { from } : {}), ...(subject ? { subject } : {}), ...(snippet ? { snippet } : {}), ...(receivedAt ? { receivedAt } : {}) });
            } catch (e) {
                // Gone between the search and the read (deleted, moved to spam): still news, the agent gets the id.
                if (e instanceof ConduitRequestError && e.status === 404) arrivals.push({ id: m.id, threadId });
                else throw e;
            }
        }
        // A capped poll keeps its window, so what it left behind is found again; a complete one moves it to now.
        const next: Cursor = { since: fresh.length > taken.length ? since : nowSec, seen: [...taken.map((m) => m.id).reverse(), ...(previous?.seen ?? [])] };
        return { kind: 'arrivals', arrivals, cursor: writeCursor(next) };
    } catch (e) {
        if (needsReauth(e)) return { kind: 'needs-reauth', message: e.message };
        throw e;
    }
}

/** The single-line field value, bounded. */
const line = (v: string, max: number): string => {
    const one = v.replace(/\s+/g, ' ').trim();
    return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/**
 * What the agent is told about one arrival: the headers and snippet only, and
 * the tool that reads the rest. The body is never put in the prompt here — the
 * agent reads it through its own connector grant, under its own policy.
 */
export function gmailArrivalText(arrival: GmailArrival, connectorId: string): string {
    const lines = [`A new email arrived in the connected Gmail account (connector "${connectorId}").`];
    if (arrival.from) lines.push(`From: ${line(arrival.from, 300)}`);
    if (arrival.subject) lines.push(`Subject: ${line(arrival.subject, 300)}`);
    if (arrival.receivedAt) lines.push(`Received: ${arrival.receivedAt}`);
    if (arrival.snippet) lines.push(`Snippet: ${line(arrival.snippet, 500)}`);
    lines.push(`Message id: ${arrival.id}${arrival.threadId ? ` (thread ${arrival.threadId})` : ''}`);
    lines.push(`Read the whole message with the ${connectorToolName(connectorId, 'get-message')} tool: {"id": ${JSON.stringify(arrival.id)}}.`);
    return lines.join('\n');
}

/** The conduit trigger this module stands in for. */
export const GMAIL_NEW_EMAIL_TRIGGER = 'new-email';

/** Whether agentic runs a conduit connector's trigger (only Gmail's `new-email`, by polling). */
export function runsTrigger(connector: string, trigger: string): boolean {
    return connector === 'gmail' && trigger === GMAIL_NEW_EMAIL_TRIGGER;
}
