/**
 * Web Push's view model (#244): pure, over the Registry's `overview()` and
 * the Inbox's `subscriptions()`, so Settings and the plugin page agree on
 * whether push is set up and what is subscribed. No hook, no DOM.
 */
import type { PluginView, PushSubscriptionRecord } from '@agentic/platform';

/** The Web Push plugin's id — pinned against `WEB_PUSH_PLUGIN_ID` by `__tests__/push.test.ts`; the client bundle never imports the platform. */
export const WEB_PUSH_PLUGIN = 'agentic.notify.web-push';
/** Its private key's secret name (`VAPID_PRIVATE_KEY_SECRET`). */
export const VAPID_SECRET = 'vapid-private-key';

export type PushSetup =
    /** No Web Push plugin in this build. */
    | { readonly state: 'absent' }
    /** Installed but turned off. */
    | { readonly state: 'off' }
    /** On, but a contact, the public key or the private key is missing. */
    | { readonly state: 'needs-keys'; readonly missing: readonly string[] }
    | { readonly state: 'ready'; readonly publicKey: string };

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Whether browsers can subscribe yet, and if not what the plugin's page still needs. */
export function pushSetup(plugins: readonly PluginView[], secretNames: readonly string[]): PushSetup {
    const p = plugins.find((x) => x.manifest.id === WEB_PUSH_PLUGIN);
    if (!p) return { state: 'absent' };
    if (!p.enabled) return { state: 'off' };
    const missing = [
        !text(p.config.subject) ? 'a contact' : '',
        !text(p.config.publicKey) ? 'a public key' : '',
        !secretNames.includes(VAPID_SECRET) ? 'the private key' : ''
    ].filter(Boolean);
    return missing.length ? { state: 'needs-keys', missing } : { state: 'ready', publicKey: text(p.config.publicKey) };
}

/** Whether "Generate keys" can run: a contact saved (the Registry refuses a config without one), and a workspace key to seal the private half. */
export function canGenerateKeys(plugin: PluginView, hasKek: boolean): { readonly ok: boolean; readonly why?: string } {
    if (!hasKek) return { ok: false, why: 'This deployment has no WORKSPACE_KEK, so it cannot seal a private key.' };
    if (!text(plugin.config.subject)) return { ok: false, why: 'Save a contact above first — push services need a way to reach you.' };
    return { ok: true };
}

export interface DeviceRow {
    readonly endpoint: string;
    readonly label: string;
    readonly addedAt: number;
    /** The subscription this browser holds. */
    readonly here: boolean;
}

/** The subscribed browsers, newest first, this one marked. */
export function deviceRows(subscriptions: readonly PushSubscriptionRecord[], hereEndpoint: string | null): DeviceRow[] {
    return [...subscriptions]
        .sort((a, b) => b.addedAt - a.addedAt)
        .map((s) => ({ endpoint: s.endpoint, label: s.label ?? hostOf(s.endpoint), addedAt: s.addedAt, here: s.endpoint === hereEndpoint }));
}

function hostOf(endpoint: string): string {
    try {
        return new URL(endpoint).host;
    } catch {
        return 'A browser';
    }
}
