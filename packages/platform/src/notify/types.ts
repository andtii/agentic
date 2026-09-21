/**
 * Notifications (AST-06, OPS-04): what reaches the user, through which
 * channel, and what happened when it was sent. The Inbox actor is the durable
 * record and the in-app channel; `NotificationChannel` is the outbound seam
 * a `notification` plugin implements (architecture §9).
 */

import type { NotificationKind, NotificationRef, WorkspaceId } from '@agentic/core';

/**
 * The kinds and the refs are core's (#359): the reminder, task and request kinds, and the daemon's update and crash
 * notices, which point at its `machine`.
 */
export type { NotificationKind, NotificationRef };

/** What a producer (Schedule, Task, Session) hands the inbox. */
export interface NotificationInput {
    readonly kind: NotificationKind;
    readonly title: string;
    readonly body?: string;
    readonly ref?: NotificationRef;
}

/** One channel's attempt to deliver one notification — recorded, never thrown (OPS-04). */
export interface DeliveryAttempt {
    readonly channel: string;
    readonly at: number;
    readonly ok: boolean;
    readonly error?: string;
}

export interface InboxNotification extends NotificationInput {
    readonly id: string;
    readonly at: number;
    readonly read: boolean;
    readonly deliveries: readonly DeliveryAttempt[];
}

/** A browser push subscription as `PushManager.subscribe()` returns it, stored on the inbox. */
export interface PushSubscriptionRecord {
    readonly endpoint: string;
    readonly keys: { readonly p256dh: string; readonly auth: string };
    readonly addedAt: number;
    /** Where it was added ("Chrome on desk"), for the settings screen. */
    readonly label?: string;
}

/** What a channel gets besides the notification: whose inbox, and where push can go. */
export interface DeliveryTarget {
    readonly workspaceId: WorkspaceId;
    readonly subscriptions: readonly PushSubscriptionRecord[];
}

export interface DeliveryResult {
    readonly ok: boolean;
    readonly error?: string;
    /** Subscription endpoints the push service reported gone (404/410); the inbox drops them. */
    readonly expired?: readonly string[];
}

/**
 * The outbound seam. `deliver` reports; it does not throw — and when it does
 * anyway, the caller records the throw as a failed attempt.
 */
export interface NotificationChannel {
    /** Stable id, recorded on every attempt (`'web-push'`). */
    readonly id: string;
    deliver(notification: InboxNotification, target: DeliveryTarget): Promise<DeliveryResult>;
}
