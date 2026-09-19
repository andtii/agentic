/**
 * Notification channels as plugins (#244, architecture §9): a channel ships
 * as a manifest the Registry lists and a `ChannelPlugin` the Inbox opens per
 * delivery from the plugin's config and secrets. The Inbox asks the Registry
 * once per notification which channels are enabled (`gate().channels`); a
 * channel opens its secrets only when it has somewhere to deliver.
 */

import type { PluginManifest } from '@agentic/core';
import type { DeliveryResult, DeliveryTarget, InboxNotification, NotificationChannel } from './types.js';
import { WEB_PUSH_CHANNEL, webPushChannel, type WebPushOptions } from './web-push.js';

/** What a notification plugin's implementation gets for one delivery. */
export interface ChannelPluginContext {
    /** The plugin's config, defaults filled in (`gate().channels[].config`). */
    readonly config: Readonly<Record<string, unknown>>;
    /** A secret the manifest declares, through `Registry.openSecret` (enabled + granted, audited); `undefined` when not set. */
    secret(name: string): Promise<string | undefined>;
}

/** A notification plugin's implementation: its channel, built for one delivery. */
export interface ChannelPlugin {
    open(context: ChannelPluginContext): NotificationChannel;
}

/** Notification plugin id → implementation. The ids are the plugins' ids. */
export type ChannelCatalogue = Readonly<Record<string, ChannelPlugin>>;

export const WEB_PUSH_PLUGIN_ID = 'agentic.notify.web-push';
export const VAPID_PRIVATE_KEY_SECRET = 'vapid-private-key';

/**
 * The Web Push channel's manifest. Off until the owner turns it on: it needs
 * a VAPID key pair first ("Generate keys" on its page), and a subscribed browser.
 */
export const webPushPlugin: PluginManifest = {
    id: WEB_PUSH_PLUGIN_ID,
    version: '0.1.0',
    kind: 'notification',
    name: 'Web Push',
    description:
        'Notifies the browsers you subscribe in Settings → Notifications, signed with this workspace’s own VAPID keys. The push carries no content: it says something needs you, and opening it shows the app.',
    capabilities: [WEB_PUSH_CHANNEL],
    config: {
        type: 'object',
        properties: {
            subject: {
                type: 'string',
                format: 'uri',
                title: 'Contact',
                description: 'A mailto: or https: address the push services can reach you at (RFC 8292). Set it before generating keys.'
            },
            publicKey: {
                type: 'string',
                title: 'Public key',
                description: 'The VAPID public key, base64url. "Generate keys" fills it in; browsers subscribe with it.'
            }
        },
        // Only the contact: it is saved first, then "Generate keys" writes the public key and the private key together.
        required: ['subject'],
        additionalProperties: false
    },
    secrets: [
        {
            name: VAPID_PRIVATE_KEY_SECRET,
            title: 'VAPID private key',
            description: 'The private half of the key pair. "Generate keys" stores it; it is only read to sign a push.',
            required: true
        }
    ],
    permissions: [{ scope: `secret:${VAPID_PRIVATE_KEY_SECRET}`, reason: 'Signs every push, so the push services accept it.' }],
    compat: { platform: '*', core: '*' }
};

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * Web Push as a `ChannelPlugin`: `webPushChannel` over the plugin's config and
 * its private key. With no subscription it does nothing — no secret opened.
 * Without a contact, a public key or the private key it reports a failed
 * attempt naming what is missing (OPS-04), never an unsigned push.
 */
export function webPushChannelPlugin(options: Omit<WebPushOptions, 'vapid'> = {}): ChannelPlugin {
    return {
        open({ config, secret }): NotificationChannel {
            return {
                id: WEB_PUSH_CHANNEL,
                async deliver(notification: InboxNotification, target: DeliveryTarget): Promise<DeliveryResult> {
                    if (target.subscriptions.length === 0) return { ok: true };
                    const subject = text(config.subject);
                    const publicKey = text(config.publicKey);
                    const missing = [!subject ? 'a contact' : '', !publicKey ? 'a public key' : ''].filter(Boolean);
                    if (missing.length > 0) return { ok: false, error: `web push is not set up: it needs ${missing.join(' and ')} (/plugins/${WEB_PUSH_PLUGIN_ID})` };
                    const privateKey = await secret(VAPID_PRIVATE_KEY_SECRET);
                    if (!privateKey) return { ok: false, error: `web push is not set up: no ${VAPID_PRIVATE_KEY_SECRET} (/plugins/${WEB_PUSH_PLUGIN_ID})` };
                    return webPushChannel({ ...options, vapid: { subject, publicKey, privateKey } }).deliver(notification, target);
                }
            };
        }
    };
}
