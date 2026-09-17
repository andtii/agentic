/**
 * Inbox actor — `{ws}:inbox` (architecture §4, AST-06). The durable,
 * capped record of what the user was told, plus the push subscriptions
 * outbound channels deliver to. Every mutation is a pure reducer step
 * (`reduceInbox`) followed by `ctx.save()` inside the turn — the Workers
 * eviction rule — so switching to `ctx.append` + `applyEntry` when
 * `@sigx/actors` ships log appends is a one-line change per method.
 */

import { defineActor } from '@sigx/actors';
import { workspaceOfKey, type WorkspaceId } from '@agentic/core';
import { sameWorkspace } from '../auth/index.js';
import { deliverAll } from './deliver.js';
import type {
    DeliveryAttempt,
    InboxNotification,
    NotificationChannel,
    NotificationInput,
    PushSubscriptionRecord
} from './types.js';

/** Notifications kept per inbox; the oldest fall off (read or not). */
export const INBOX_CAP = 500;

export function inboxKey(workspace: WorkspaceId): string {
    return `${workspace}:inbox`;
}

export interface InboxState {
    /** Monotonic id source; ids are `n_<seq>`, unique within one inbox. */
    seq: number;
    /** Oldest first. */
    notifications: InboxNotification[];
    subscriptions: PushSubscriptionRecord[];
}

export type InboxEntry =
    | { readonly type: 'append'; readonly notification: InboxNotification }
    | { readonly type: 'delivered'; readonly id: string; readonly attempts: readonly DeliveryAttempt[] }
    | { readonly type: 'ack'; readonly ids: readonly string[] | 'all' }
    | { readonly type: 'subscribe'; readonly subscription: PushSubscriptionRecord }
    | { readonly type: 'unsubscribe'; readonly endpoints: readonly string[] };

export function initialInboxState(): InboxState {
    return { seq: 0, notifications: [], subscriptions: [] };
}

/** The reducer every Inbox mutation goes through. Pure over the state it is given (a signal proxy in the actor). */
export function reduceInbox(state: InboxState, entry: InboxEntry, cap: number = INBOX_CAP): void {
    switch (entry.type) {
        case 'append': {
            state.seq += 1;
            state.notifications.push(entry.notification);
            const excess = state.notifications.length - cap;
            if (excess > 0) state.notifications.splice(0, excess);
            return;
        }
        case 'delivered': {
            const i = state.notifications.findIndex((n) => n.id === entry.id);
            if (i < 0) return; // capped away while delivering — nothing to record on
            const current = state.notifications[i]!;
            state.notifications[i] = { ...current, deliveries: [...current.deliveries, ...entry.attempts] };
            return;
        }
        case 'ack': {
            const all = entry.ids === 'all';
            for (let i = 0; i < state.notifications.length; i++) {
                const n = state.notifications[i]!;
                if (!n.read && (all || entry.ids.includes(n.id))) state.notifications[i] = { ...n, read: true };
            }
            return;
        }
        case 'subscribe': {
            const i = state.subscriptions.findIndex((s) => s.endpoint === entry.subscription.endpoint);
            if (i < 0) state.subscriptions.push(entry.subscription);
            else state.subscriptions[i] = entry.subscription;
            return;
        }
        case 'unsubscribe': {
            state.subscriptions = state.subscriptions.filter((s) => !entry.endpoints.includes(s.endpoint));
            return;
        }
    }
}

export interface ListOptions {
    readonly unreadOnly?: boolean;
    /** Newest first; default all. */
    readonly limit?: number;
}

export interface InboxOptions {
    /** Notifications kept; default {@link INBOX_CAP}. */
    readonly cap?: number;
    /** Outbound channels `push` fans out to after the inbox record is durable. */
    readonly channels?: readonly NotificationChannel[];
    /** Clock, for tests. */
    readonly now?: () => number;
}

/**
 * Build the Inbox definition. The default export {@link Inbox} has no outbound
 * channels; the app registers `defineInbox({ channels: [webPushChannel(...)] })`
 * where the environment (VAPID keys, fetch) is known. Both share the type
 * `'Inbox'`, so a client-side `actor(Inbox, key)` reaches whichever the host runs.
 */
export function defineInbox(options: InboxOptions = {}) {
    const cap = options.cap ?? INBOX_CAP;
    const channels = options.channels ?? [];
    const now = options.now ?? Date.now;

    return defineActor({
        type: 'Inbox',
        authorize: [sameWorkspace],
        state: initialInboxState,
        reads: { list: { maxAge: 0 }, unread: { maxAge: 0 } },
        methods: (ctx) => {
            const workspaceId = (): WorkspaceId => workspaceOfKey(ctx.key) ?? ('' as WorkspaceId);
            const find = (id: string): InboxNotification | undefined => ctx.state.notifications.find((n) => n.id === id);

            const append = async (input: NotificationInput): Promise<InboxNotification> => {
                const notification: InboxNotification = {
                    kind: input.kind,
                    title: input.title,
                    ...(input.body !== undefined ? { body: input.body } : {}),
                    ...(input.ref !== undefined ? { ref: input.ref } : {}),
                    id: `n_${ctx.state.seq + 1}`,
                    at: now(),
                    read: false,
                    deliveries: []
                };
                reduceInbox(ctx.state, { type: 'append', notification }, cap);
                await ctx.save();
                return notification;
            };

            return {
                /** Record only — what `Schedule.onReminder` and Task use when no outbound delivery is wanted. */
                append,

                /** Record, then deliver through every channel; attempts land on the record (OPS-04). */
                async push(input: NotificationInput): Promise<InboxNotification> {
                    const notification = await append(input);
                    if (channels.length === 0) return notification;
                    const target = { workspaceId: workspaceId(), subscriptions: ctx.snapshot(ctx.state.subscriptions) };
                    const report = await deliverAll(channels, notification, target, now);
                    reduceInbox(ctx.state, { type: 'delivered', id: notification.id, attempts: report.attempts }, cap);
                    if (report.expired.length > 0) reduceInbox(ctx.state, { type: 'unsubscribe', endpoints: report.expired }, cap);
                    await ctx.save();
                    return ctx.snapshot(find(notification.id)) ?? { ...notification, deliveries: report.attempts };
                },

                /** Newest first. A live read: `useActorState(Inbox, key).list({ unreadOnly: true })` re-runs after every mutating turn. */
                list(options: ListOptions = {}): InboxNotification[] {
                    let rows = ctx.snapshot(ctx.state.notifications);
                    if (options.unreadOnly) rows = rows.filter((n) => !n.read);
                    rows.reverse();
                    return options.limit !== undefined ? rows.slice(0, options.limit) : rows;
                },

                unread(): number {
                    let n = 0;
                    for (const row of ctx.state.notifications) if (!row.read) n++;
                    return n;
                },

                /** Mark read. Returns how many changed. */
                async ack(ids: readonly string[] | 'all'): Promise<number> {
                    const before = ctx.state.notifications.filter((n) => !n.read).length;
                    reduceInbox(ctx.state, { type: 'ack', ids }, cap);
                    const changed = before - ctx.state.notifications.filter((n) => !n.read).length;
                    if (changed > 0) await ctx.save();
                    return changed;
                },

                async subscribe(subscription: Omit<PushSubscriptionRecord, 'addedAt'>): Promise<void> {
                    reduceInbox(ctx.state, { type: 'subscribe', subscription: { ...subscription, addedAt: now() } }, cap);
                    await ctx.save();
                },

                async unsubscribe(endpoint: string): Promise<boolean> {
                    const had = ctx.state.subscriptions.some((s) => s.endpoint === endpoint);
                    if (!had) return false;
                    reduceInbox(ctx.state, { type: 'unsubscribe', endpoints: [endpoint] }, cap);
                    await ctx.save();
                    return true;
                },

                subscriptions(): PushSubscriptionRecord[] {
                    return ctx.snapshot(ctx.state.subscriptions);
                }
            };
        }
    });
}

/** The Inbox with no outbound channels: the in-app inbox alone. */
export const Inbox = defineInbox();
