/**
 * Web Push's keys, written once (#543): the contact, the public key and the
 * sealed private key the platform signs with. Both "Generate keys" on the
 * plugin page and "Turn on push notifications" in Settings go through here,
 * so the pair is always written the same way and the private key only ever
 * travels from WebCrypto to `Registry.setSecret`.
 */
import type { PluginView } from '@agentic/platform';
import { generateVapidKeys } from './browser';
import { VAPID_SECRET, defaultContact } from './model';

/** The Registry calls this needs — an actor ref, or a fake in tests. */
export interface PushKeysRegistry {
    configure(id: string, config: Record<string, unknown>): Promise<PluginView>;
    setSecret(name: string, value: string): Promise<unknown>;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * A fresh key pair for `plugin`, keeping its saved contact or filling in
 * `defaultContact(origin)`. Answers the new public key. Replacing an existing
 * pair is the caller's decision: every browser subscribed with the old one has
 * to subscribe again.
 */
export async function writePushKeys(registry: PushKeysRegistry, plugin: PluginView, origin: string): Promise<string> {
    const keys = await generateVapidKeys();
    const subject = text(plugin.config.subject) || defaultContact(origin);
    // Contact and public key in one configure: the Registry refuses a config without a contact.
    await registry.configure(plugin.manifest.id, { ...plugin.config, subject, publicKey: keys.publicKey });
    await registry.setSecret(VAPID_SECRET, keys.privateKey);
    return keys.publicKey;
}

/**
 * The workspace's public key, making a pair only when there is none. A second
 * browser turning push on reuses the pair, so the browsers already subscribed
 * keep getting pushes.
 */
export async function ensurePushKeys(registry: PushKeysRegistry, plugin: PluginView, hasPrivateKey: boolean, origin: string): Promise<string> {
    const publicKey = text(plugin.config.publicKey);
    if (publicKey && hasPrivateKey) return publicKey;
    return writePushKeys(registry, plugin, origin);
}
