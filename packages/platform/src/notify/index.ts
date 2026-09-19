/** Notifications: the `NotificationChannel` seam, the Inbox actor, the Web Push channel (architecture §4 Inbox, §9). */

export type {
    DeliveryAttempt,
    DeliveryResult,
    DeliveryTarget,
    InboxNotification,
    NotificationChannel,
    NotificationInput,
    NotificationKind,
    NotificationRef,
    PushSubscriptionRecord
} from './types.js';
export { deliverAll, type DeliveryReport } from './deliver.js';
export {
    Inbox,
    defineInbox,
    inboxKey,
    sameRef,
    initialInboxState,
    reduceInbox,
    INBOX_CAP,
    PLUGIN_CHANNELS,
    type InboxEntry,
    type InboxOptions,
    type InboxState,
    type ListOptions
} from './inbox.js';
export { webPushChannel, vapidSigner, WEB_PUSH_CHANNEL, type VapidKeys, type VapidSigner, type WebPushOptions } from './web-push.js';
export {
    webPushPlugin,
    webPushChannelPlugin,
    WEB_PUSH_PLUGIN_ID,
    VAPID_PRIVATE_KEY_SECRET,
    type ChannelCatalogue,
    type ChannelPlugin,
    type ChannelPluginContext
} from './plugins.js';
export { toBase64Url, fromBase64Url } from './encoding.js';
