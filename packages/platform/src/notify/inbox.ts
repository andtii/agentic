/**
 * Inbox actor — `{ws}:inbox` (architecture §4, AST-06). The durable,
 * capped record of what the user was told, plus the push subscriptions
 * outbound channels deliver to. Every mutation is a pure reducer step
 * (`reduceInbox`) followed by `ctx.save()` inside the turn — the Workers
 * eviction rule — so switching to `ctx.append` + `applyEntry` when
 * `@sigx/actors` ships log appends is a one-line change per method.
 */

import { actor, defineActor, type AnyActorDefinition } from '@sigx/actors';
import { workspaceOfKey, type WorkspaceId } from '@agentic/core';
import { asPrincipal, sameWorkspace, userPrincipal } from '../auth/index.js';
import { registryKey } from '../registry/key.js';
import { deliverAll } from './deliver.js';
import type { ChannelCatalogue } from './plugins.js';
import type {
    DeliveryAttempt,
    InboxNotification,
    NotificationChannel,
    NotificationInput,
    NotificationRef,
    PushSubscriptionRecord
} from './types.js';

/** Notifications kept per inbox; the oldest fall off (read or not). */
export const INBOX_CAP = 500;

export function inboxKey(workspace: WorkspaceId): string {
    return `${workspace}:inbox`;
}

/** Two refs name the same thing: every field of `b` matches `a` (a ref without a `requestId` matches the whole session). */
export function sameRef(a: NotificationRef, b: NotificationRef): boolean {
    if (a.kind !== b.kind) return false;
    for (const [k, v] of Object.entries(b)) if ((a as Record<string, unknown>)[k] !== v) return false;
    return true;
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
    /** Outbound channels `push` always fans out to after the inbox record is durable — tests, or a channel that is no plugin. */
    readonly channels?: readonly NotificationChannel[];
    /**
     * Channels that are plugins (#244): `push` asks the Registry once which
     * notification plugins are enabled (`gate().channels`) and opens each one
     * this build implements, with its config and a secret opener. Needs `registry`.
     */
    readonly channelPlugins?: ChannelCatalogue;
    /** The Registry definition `channelPlugins` are resolved through. */
    readonly registry?: () => AnyActorDefinition;
    /** Clock, for tests. */
    readonly now?: () => number;
}

/** What the Inbox asks the Registry, as the workspace's owner. */
interface RegistryChannels {
    gate(): Promise<{ readonly channels: readonly { readonly id: string; readonly config: Record<string, unknown> }[] }>;
    openSecret(name: string, pluginId: string): Promise<string>;
}

/** A Registry refusal's code, whether the error crossed a hop as a code or only as its message. */
function secretMissing(error: unknown): boolean {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'secret-missing') return true;
    return error instanceof Error && /\[registry\] no secret "/.test(error.message);
}

/** The attempt recorded when the Registry cannot be asked which channels are on (OPS-04: shown, not lost). */
export const PLUGIN_CHANNELS = 'plugins';

/**
 * Build the Inbox definition. The default export {@link Inbox} has no outbound
 * channels; the app registers `defineInbox({ channelPlugins, registry })` so the
 * workspace's enabled notification plugins deliver (#244). Both share the type
 * `'Inbox'`, so a client-side `actor(Inbox, key)` reaches whichever the host runs.
 */
export function defineInbox(options: InboxOptions = {}) {
    const cap = options.cap ?? INBOX_CAP;
    const staticChannels = options.channels ?? [];
    const plugins = options.channelPlugins && options.registry ? { impls: options.channelPlugins, registry: options.registry } : null;
    const now = options.now ?? Date.now;

    /**
     * The channels one notification goes through: the static ones, then every enabled
     * notification plugin this build implements — one Registry hop, whatever the number
     * of subscribers. A Registry that cannot be asked is a recorded failure, not a throw.
     */
    const channelsFor = async (workspaceId: WorkspaceId): Promise<{ channels: NotificationChannel[]; failed?: string }> => {
        if (!plugins) return { channels: [...staticChannels] };
        let registry: RegistryChannels;
        let enabled: readonly { readonly id: string; readonly config: Record<string, unknown> }[];
        try {
            // As the workspace's owner (v1: `workspaceId === userId`): whoever pushed, the Registry audits who opened a secret.
            registry = actor(plugins.registry(), registryKey(workspaceId)).with({ context: asPrincipal(userPrincipal(workspaceId, workspaceId)) }) as unknown as RegistryChannels;
            enabled = (await registry.gate()).channels;
        } catch (e) {
            return { channels: [...staticChannels], failed: `the plugin registry could not be asked which channels are on: ${e instanceof Error ? e.message : String(e)}` };
        }
        const opened = enabled.flatMap(({ id, config }) => {
            const impl = plugins.impls[id];
            if (!impl) return [];
            return [
                impl.open({
                    config,
                    async secret(name) {
                        try {
                            return await registry.openSecret(name, id);
                        } catch (e) {
                            if (secretMissing(e)) return undefined;
                            throw e;
                        }
                    }
                })
            ];
        });
        return { channels: [...staticChannels, ...opened] };
    };

    return defineActor({
        type: 'Inbox',
        authorize: [sameWorkspace],
        state: initialInboxState,
        reads: { list: { maxAge: 0 }, unread: { maxAge: 0 }, subscriptions: { maxAge: 0 } },
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
                    if (staticChannels.length === 0 && !plugins) return notification;
                    const { channels, failed } = await channelsFor(workspaceId());
                    if (channels.length === 0 && failed === undefined) return notification;
                    const target = { workspaceId: workspaceId(), subscriptions: ctx.snapshot(ctx.state.subscriptions) };
                    const report = await deliverAll(channels, notification, target, now);
                    const attempts = failed === undefined ? report.attempts : [...report.attempts, { channel: PLUGIN_CHANNELS, at: now(), ok: false, error: failed }];
                    reduceInbox(ctx.state, { type: 'delivered', id: notification.id, attempts }, cap);
                    if (report.expired.length > 0) reduceInbox(ctx.state, { type: 'unsubscribe', endpoints: report.expired }, cap);
                    await ctx.save();
                    return ctx.snapshot(find(notification.id)) ?? { ...notification, deliveries: attempts };
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

                /**
                 * Mark every notification about `ref` read — what a Session calls once a
                 * request is answered from any client, so the other clients' "needs you"
                 * lists drop it (OPS-02). Returns how many changed.
                 */
                async ackRef(ref: NotificationRef): Promise<number> {
                    const ids = ctx.state.notifications.filter((n) => !n.read && n.ref !== undefined && sameRef(n.ref, ref)).map((n) => n.id);
                    if (ids.length === 0) return 0;
                    reduceInbox(ctx.state, { type: 'ack', ids }, cap);
                    await ctx.save();
                    return ids.length;
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

                /** The browsers push goes to. A live read: Settings → Notifications lists them. */
                subscriptions(): PushSubscriptionRecord[] {
                    return ctx.snapshot(ctx.state.subscriptions);
                }
            };
        }
    });
}

/** The Inbox with no outbound channels: the in-app inbox alone. */
export const Inbox = defineInbox();
