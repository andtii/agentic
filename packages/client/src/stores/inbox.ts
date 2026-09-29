/**
 * The inbox store (#1123): the one owner of the viewer's "Needs you" reads —
 * the workspace Inbox's `list` (every notification the Sessions and daemons
 * pushed), the router's `Routing.get()` (the routes parked `interrupted`) and
 * the workspace Audit's newest interruption rows (why a turn was cut, keyed by
 * the log's live `stats` so every recorded row re-reads them). The shell's
 * badge, Home's "Needs you", the inbox page and the chat's detached questions
 * all read these here, so a route change reuses the app's subscriptions
 * instead of redialling the Inbox, Routing and Audit actors.
 *
 * The rows themselves (which notification is a row, how an interrupted route
 * reads) are the web's fold over these values (`apps/web/src/pages/inbox/live.ts`).
 * With no actor definitions or viewer provided (a render on mock data), the
 * store reads nothing and every selector answers empty.
 */
import { actor } from '@sigx/actors';
import { computed } from '@sigx/reactivity';
import { useData } from '@sigx/runtime-core';
import type { AuditEvent, AuditPage, InboxNotification, Route, RoutingView } from '@agentic/platform';
import { useActorDefs } from '../defs';
import { useViewer } from '../viewer';
import { defineAppStore } from './define';
import { useLiveActorState, type LiveActorState } from './live';

/** The audit kinds an interruption is read from (the web's `INTERRUPTION_KINDS`, spelled here so the store needs no web import). */
export const INTERRUPTION_AUDIT_KINDS = ['session.interrupted', 'session.resumed', 'task.machine-lost'] as const;

/** How many of the newest interruption rows are read: enough for what is still on screen. */
export const INTERRUPTION_AUDIT_ROWS = 50;

/** The platform's actor keys (`apps/web/src/actors/keys.ts`), spelled here so the bundle never imports the platform for a string. */
const inboxKeyOf = (ws: string): string => `${ws}:inbox`;
const routingKeyOf = (ws: string): string => `${ws}:routing:main`;
const auditKeyOf = (ws: string): string => `${ws}:audit`;

/** The read a store without actor definitions holds: never loading, never a value. */
const idle = <T>(): LiveActorState<T> => ({ state: 'idle', value: undefined, hasValue: false, loading: false, error: null, refresh: async () => undefined });

/** An injectable the app may not provide (a render on mock data): `null` then. */
function optional<T>(use: () => T): T | null {
    try {
        return use();
    } catch {
        return null;
    }
}

export const useInboxStore = defineAppStore('inbox', (ctx) => {
    const defs = optional(useActorDefs);
    const viewer = defs ? optional(() => useViewer()()) : null;
    const ws = (): string | null => viewer?.workspaceId ?? null;
    const list = defs?.Inbox && viewer ? useLiveActorState(ctx, defs.Inbox, () => { const w = ws(); return w ? ([inboxKeyOf(w), 'list'] as const) : null; }) : idle<readonly InboxNotification[]>();
    const routing = defs?.Routing && viewer ? useLiveActorState(ctx, defs.Routing, () => { const w = ws(); return w ? ([routingKeyOf(w), 'get'] as const) : null; }) : idle<RoutingView>();
    // `Audit.list` takes a query object, which a live read's key cannot carry: the log's live `stats` keys the read
    // instead (as the History page does), so every recorded row re-reads it.
    const stats = defs?.Audit && viewer ? useLiveActorState(ctx, defs.Audit, () => { const w = ws(); return w ? ([auditKeyOf(w), 'stats'] as const) : null; }) : idle<{ readonly recorded: number }>();
    const Audit = defs?.Audit;
    const auditPage = Audit && viewer
        ? useData(
            () => {
                const w = ws();
                return w ? (['interruptions', w, '', stats.value?.recorded ?? -1] as const) : false;
            },
            async (key): Promise<AuditPage> => actor(Audit, auditKeyOf(key[1])).list({ kinds: [...INTERRUPTION_AUDIT_KINDS], limit: INTERRUPTION_AUDIT_ROWS })
        )
        : null;

    /** `Inbox.list()`: every notification, read or not; empty until it lands. */
    const notifications = computed((): readonly InboxNotification[] => list.value ?? []);
    /** Every route the router holds (`Routing.get().routes`); empty until it lands. */
    const routes = computed((): readonly Route[] => routing.value?.routes ?? []);
    /** The workspace's newest interruption rows (`INTERRUPTION_AUDIT_KINDS`), newest first; empty while loading or unreadable. */
    const interruptions = computed((): readonly AuditEvent[] => auditPage?.value?.events ?? []);
    /** The Audit's `stats().recorded`, `-1` until it lands: a page reading its own (task-narrowed) interruption rows keys them by it. */
    const auditRecorded = computed((): number => stats.value?.recorded ?? -1);

    return {
        notifications,
        routes,
        interruptions,
        auditRecorded,
        /** The reads themselves, for a page that needs a read's state (`loading`, `error`) as well as its value. */
        listRead: list,
        routingRead: routing
    };
});
