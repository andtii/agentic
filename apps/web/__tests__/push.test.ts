/**
 * Web Push in the browser (#244): the ids the client spells without the
 * platform, whether push is set up, the device list, the guarded capability
 * check, and a key pair the platform's signer accepts.
 */
import { describe, expect, it } from 'vitest';
import { VAPID_PRIVATE_KEY_SECRET, WEB_PUSH_PLUGIN_ID, vapidSigner, webPushPlugin, type PluginView } from '@agentic/platform';
import { deviceLabel, fromBase64Url, generateVapidKeys, pushSupport, toBase64Url } from '../src/push/browser';
import { VAPID_SECRET, WEB_PUSH_PLUGIN, canGenerateKeys, defaultContact, deviceRows, pushSetup } from '../src/push/model';
import { ensurePushKeys, type PushKeysRegistry } from '../src/push/setup';

const view = (patch: Partial<PluginView> = {}): PluginView => ({
    manifest: webPushPlugin,
    enabled: true,
    config: {},
    grantedPermissions: [`secret:${VAPID_PRIVATE_KEY_SECRET}`],
    registeredAt: 0,
    updatedAt: 0,
    builtin: true,
    ...patch
});

describe('push ids', () => {
    it('match the platform', () => {
        expect(WEB_PUSH_PLUGIN).toBe(WEB_PUSH_PLUGIN_ID);
        expect(VAPID_SECRET).toBe(VAPID_PRIVATE_KEY_SECRET);
    });
});

describe('pushSetup', () => {
    it('absent, off, what is missing, then ready with the public key', () => {
        expect(pushSetup([], [])).toEqual({ state: 'absent' });
        expect(pushSetup([view({ enabled: false })], [])).toEqual({ state: 'off' });
        expect(pushSetup([view()], [])).toEqual({ state: 'needs-keys', missing: ['a contact', 'a public key', 'the private key'] });
        expect(pushSetup([view({ config: { subject: 'mailto:a@b.c', publicKey: 'BPUB' } })], [])).toEqual({ state: 'needs-keys', missing: ['the private key'] });
        expect(pushSetup([view({ config: { subject: 'mailto:a@b.c', publicKey: 'BPUB' } })], [VAPID_SECRET])).toEqual({ state: 'ready', publicKey: 'BPUB' });
    });
});

describe('canGenerateKeys', () => {
    it('needs only a workspace key — a missing contact gets the default', () => {
        expect(canGenerateKeys(false)).toMatchObject({ ok: false, why: expect.stringMatching(/WORKSPACE_KEK/) });
        expect(canGenerateKeys(true)).toEqual({ ok: true });
    });
});

describe('defaultContact', () => {
    it('the https origin, else a mailto: on the host — both pass the platform', () => {
        expect(defaultContact('https://agentic.example.com')).toBe('https://agentic.example.com');
        expect(defaultContact('http://localhost:8787')).toBe('mailto:push@localhost');
        expect(defaultContact('not a url')).toBe('mailto:push@localhost');
    });
});

describe('ensurePushKeys', () => {
    const fake = () => {
        const calls: string[] = [];
        const configs: Record<string, unknown>[] = [];
        const registry: PushKeysRegistry = {
            configure: async (_id, config) => { calls.push('configure'); configs.push(config); return view({ config }); },
            setSecret: async (name) => { calls.push(`setSecret:${name}`); return {}; }
        };
        return { registry, calls, configs };
    };

    it('makes a pair when there is none, with the default contact', async () => {
        const f = fake();
        const publicKey = await ensurePushKeys(f.registry, view(), false, 'https://app.example');
        expect(publicKey).toMatch(/^[\w-]{87}$/);
        expect(f.calls).toEqual(['configure', `setSecret:${VAPID_SECRET}`]);
        expect(f.configs[0]).toEqual({ subject: 'https://app.example', publicKey });
    });

    it('keeps a saved contact', async () => {
        const f = fake();
        await ensurePushKeys(f.registry, view({ config: { subject: 'mailto:me@b.c' } }), false, 'https://app.example');
        expect(f.configs[0]!.subject).toBe('mailto:me@b.c');
    });

    it('reuses the pair for another browser, so the ones already subscribed keep their pushes', async () => {
        const f = fake();
        const publicKey = await ensurePushKeys(f.registry, view({ config: { subject: 'mailto:me@b.c', publicKey: 'BPUB' } }), true, 'https://app.example');
        expect(publicKey).toBe('BPUB');
        expect(f.calls).toEqual([]);
    });
});

describe('deviceRows', () => {
    it('newest first, this browser marked, a label or the push host', () => {
        const rows = deviceRows(
            [
                { endpoint: 'https://fcm.googleapis.com/fcm/send/a', keys: { p256dh: 'p', auth: 'a' }, addedAt: 1, label: 'Chrome on Windows' },
                { endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/b', keys: { p256dh: 'p', auth: 'a' }, addedAt: 2 }
            ],
            'https://fcm.googleapis.com/fcm/send/a'
        );
        expect(rows.map((r) => [r.label, r.here])).toEqual([['updates.push.services.mozilla.com', false], ['Chrome on Windows', true]]);
    });

    it('names a browser from its user agent', () => {
        expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36')).toBe('Chrome on Windows');
        expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0')).toBe('Edge on Windows');
        expect(deviceLabel('Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0')).toBe('Firefox on Linux');
    });
});

describe('pushSupport', () => {
    it('is unsupported without the APIs and insecure off https — never a throw', () => {
        expect(pushSupport({} as typeof globalThis)).toBe('unsupported');
        expect(pushSupport({ navigator: {} } as unknown as typeof globalThis)).toBe('unsupported');
        const g = { navigator: { serviceWorker: {} }, PushManager: class {}, Notification: class {} };
        expect(pushSupport({ ...g, isSecureContext: false } as unknown as typeof globalThis)).toBe('insecure');
        expect(pushSupport({ ...g, isSecureContext: true } as unknown as typeof globalThis)).toBe('supported');
    });
});

describe('generateVapidKeys', () => {
    it('makes a P-256 pair the platform signer accepts and whose token the public key verifies', async () => {
        const keys = await generateVapidKeys();
        const point = fromBase64Url(keys.publicKey);
        expect(point).toHaveLength(65);
        expect(point[0]).toBe(4);
        expect(fromBase64Url(keys.privateKey)).toHaveLength(32);

        const header = await vapidSigner({ ...keys, subject: 'mailto:me@example.com' }).authorization('https://push.example', Date.now());
        const [, jwt] = /^vapid t=([^,]+), k=/.exec(header)!;
        const [h, c, s] = jwt!.split('.');
        const publicKey = await crypto.subtle.importKey('raw', point, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
        const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, fromBase64Url(s!), new TextEncoder().encode(`${h}.${c}`));
        expect(ok).toBe(true);
        expect(toBase64Url(point)).toBe(keys.publicKey);
    });
});
