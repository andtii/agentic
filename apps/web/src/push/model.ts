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

/** Whether "Generate keys" can run: only a workspace key to seal the private half is needed — a missing contact gets `defaultContact`. */
export function canGenerateKeys(hasKek: boolean): { readonly ok: boolean; readonly why?: string } {
    if (!hasKek) return { ok: false, why: 'This deployment has no WORKSPACE_KEK, so it cannot seal a private key (wrangler secret put WORKSPACE_KEK).' };
    return { ok: true };
}

/**
 * The contact push services get when nobody typed one (RFC 8292 `sub`): the
 * app's own address when it is served over https, else a `mailto:` on its
 * host — plain http only ever pushes from localhost, where the push services
 * do not check it.
 */
export function defaultContact(origin: string): string {
    try {
        const url = new URL(origin);
        return url.protocol === 'https:' ? url.origin : `mailto:push@${url.hostname || 'localhost'}`;
    } catch {
        return 'mailto:push@localhost';
    }
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
