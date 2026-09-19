/**
 * Notification channels as plugins (#244): the Inbox asks the Registry once
 * per notification which notification plugins are on, opens each with its
 * config and a secret opener, and records what happened (OPS-04). Web Push
 * is a plugin: off by default, `needs-config` → `needs-secret` → ready, and
 * its private key is read only to sign a push that has somewhere to go.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pluginReadiness, type WorkspaceId } from '@agentic/core';
import { AuditActor, auditKey } from '../../src/audit/index';
import { generateWorkspaceKek, importWorkspaceKek } from '../../src/auth/index';
import { defineRegistry, registryKey } from '../../src/registry/index';
import {
    PLUGIN_CHANNELS,
    VAPID_PRIVATE_KEY_SECRET,
    WEB_PUSH_CHANNEL,
    WEB_PUSH_PLUGIN_ID,
    defineInbox,
    inboxKey,
    toBase64Url,
    webPushChannelPlugin,
    webPushPlugin,
    type ChannelPlugin,
    type ChannelPluginContext
} from '../../src/notify/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';
import { Workspace } from '../../src/workspace/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const KEK = generateWorkspaceKek();
const Registry = defineRegistry({ kek: () => importWorkspaceKek(KEK), catalogue: [{ manifest: webPushPlugin, enabledByDefault: false }] });
const SUB = { endpoint: 'https://push.example/sub/1', keys: { p256dh: 'p', auth: 'a' } };

let app: TestActorApp;
afterEach(() => app?.stop());

const reg = () => app.as(owner).actor(Registry, registryKey(WS));
const secretOpens = async () => (await app.as(owner).actor(AuditActor, auditKey(WS)).list({ kinds: ['secret.opened'] })).events;

/** A channel plugin that records what it was opened with and what it delivered. */
function recordingPlugin() {
    const calls = { opened: [] as { config: Record<string, unknown>; secret: string | undefined }[], delivered: 0 };
    const plugin: ChannelPlugin = {
        open(context: ChannelPluginContext) {
            return {
                id: 'recorder',
                async deliver() {
                    calls.opened.push({ config: { ...context.config }, secret: await context.secret(VAPID_PRIVATE_KEY_SECRET) });
                    calls.delivered += 1;
                    return { ok: true };
                }
            };
        }
    };
    return { plugin, calls };
}

async function vapidPair(): Promise<{ publicKey: string; privateKey: string }> {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    return { publicKey: toBase64Url(raw), privateKey: jwk.d! };
}

describe('Inbox — notification channels from enabled plugins', () => {
    let rec: ReturnType<typeof recordingPlugin>;
    const inbox = () => app.as(owner).actor(Inbox, inboxKey(WS));
    let Inbox: ReturnType<typeof defineInbox>;

    beforeEach(async () => {
        rec = recordingPlugin();
        Inbox = defineInbox({ registry: () => Registry, channelPlugins: { [WEB_PUSH_PLUGIN_ID]: rec.plugin } });
        app = testActorApp([Inbox, Registry, AuditActor, Workspace]);
        await app.start();
    });

    it('a plugin that is off is never opened: no attempt, no secret read', async () => {
        await inbox().subscribe(SUB);
        const n = await inbox().push({ kind: 'reminder', title: 'Stand-up' });
        expect(rec.calls.delivered).toBe(0);
        expect(n.deliveries).toEqual([]);
        expect(await secretOpens()).toEqual([]);
    });

    it('an enabled, configured plugin delivers with its config and its opened secret', async () => {
        await reg().configure(WEB_PUSH_PLUGIN_ID, { subject: 'mailto:me@example.com', publicKey: 'BPUB' });
        await reg().setSecret(VAPID_PRIVATE_KEY_SECRET, 'the-private-key');
        await reg().enable(WEB_PUSH_PLUGIN_ID);
        await inbox().subscribe(SUB);

        const n = await inbox().push({ kind: 'task-done', title: 'Report ready' });
        expect(rec.calls.delivered).toBe(1);
        expect(rec.calls.opened[0]).toEqual({ config: { subject: 'mailto:me@example.com', publicKey: 'BPUB' }, secret: 'the-private-key' });
        expect(n.deliveries).toMatchObject([{ channel: 'recorder', ok: true }]);
        // The Registry audited the release, once, for this plugin.
        expect((await secretOpens()).map((e) => e.data)).toEqual([{ name: VAPID_PRIVATE_KEY_SECRET, pluginId: WEB_PUSH_PLUGIN_ID }]);
        // And the value is nowhere on the inbox record.
        expect(JSON.stringify(await inbox().list())).not.toContain('the-private-key');
    });

    it('a secret that is not set reaches the channel as undefined, not a throw', async () => {
        await reg().enable(WEB_PUSH_PLUGIN_ID);
        await inbox().subscribe(SUB);
        await inbox().push({ kind: 'reminder', title: 'x' });
        expect(rec.calls.opened[0]!.secret).toBeUndefined();
    });

    it('turning the plugin off again stops delivery for the next notification', async () => {
        await reg().enable(WEB_PUSH_PLUGIN_ID);
        await inbox().subscribe(SUB);
        await inbox().push({ kind: 'reminder', title: 'one' });
        await reg().disable(WEB_PUSH_PLUGIN_ID);
        await inbox().push({ kind: 'reminder', title: 'two' });
        expect(rec.calls.delivered).toBe(1);
    });
});

describe('Inbox.unsubscribe — many at once', () => {
    it('drops every endpoint given in one save, and answers how many it had', async () => {
        const Inbox = defineInbox();
        app = testActorApp([Inbox]);
        await app.start();
        const inbox = app.as(owner).actor(Inbox, inboxKey(WS));
        for (const n of [1, 2, 3]) await inbox.subscribe({ ...SUB, endpoint: `https://push.example/sub/${n}` });
        const saves = app.saves.filter((r) => r.type === 'Inbox').length;
        expect(await inbox.unsubscribe(['https://push.example/sub/1', 'https://push.example/sub/3', 'https://push.example/gone'])).toBe(2);
        expect(app.saves.filter((r) => r.type === 'Inbox').length - saves).toBe(1);
        expect((await inbox.subscriptions()).map((s) => s.endpoint)).toEqual(['https://push.example/sub/2']);
        // One endpoint still answers a boolean, as before.
        expect(await inbox.unsubscribe('https://push.example/sub/2')).toBe(true);
        expect(await inbox.unsubscribe('https://push.example/sub/2')).toBe(false);
    });
});

describe('Inbox — a Registry that cannot be asked', () => {
    it('records a failed attempt instead of throwing, and keeps the static channels', async () => {
        const delivered: string[] = [];
        const Missing = defineRegistry({ catalogue: [] });
        // The Registry definition is never hosted: the hop fails.
        const Inbox = defineInbox({
            registry: () => Missing,
            channelPlugins: {},
            channels: [{ id: 'always', deliver: async (n) => { delivered.push(n.title); return { ok: true }; } }]
        });
        app = testActorApp([Inbox]);
        await app.start();
        const n = await app.as(owner).actor(Inbox, inboxKey(WS)).push({ kind: 'reminder', title: 'Stand-up' });
        expect(delivered).toEqual(['Stand-up']);
        expect(n.deliveries.map((d) => [d.channel, d.ok])).toEqual([['always', true], [PLUGIN_CHANNELS, false]]);
        expect(n.deliveries[1]!.error).toMatch(/plugin registry could not be asked/);
    });
});

describe('webPushPlugin', () => {
    it('is a notification plugin whose secret has its scope', () => {
        expect(webPushPlugin.kind).toBe('notification');
        expect(webPushPlugin.secrets?.map((s) => s.name)).toEqual([VAPID_PRIVATE_KEY_SECRET]);
        expect(webPushPlugin.permissions.map((p) => p.scope)).toContain(`secret:${VAPID_PRIVATE_KEY_SECRET}`);
    });

    it('readiness: off → needs a contact → needs the private key → ready; the contact saves on its own', async () => {
        app = testActorApp([Registry, AuditActor]);
        await app.start();
        const readiness = async () => {
            const o = await reg().overview();
            const p = o.plugins.find((x) => x.manifest.id === WEB_PUSH_PLUGIN_ID)!;
            return pluginReadiness(p, { secretNames: o.secretNames, environments: [], hasKek: o.hasKek }).status;
        };
        expect(await readiness()).toBe('disabled');
        await reg().enable(WEB_PUSH_PLUGIN_ID);
        expect(await readiness()).toBe('needs-config');
        await reg().configure(WEB_PUSH_PLUGIN_ID, { subject: 'mailto:me@example.com' });
        expect(await readiness()).toBe('needs-secret');
        await reg().configure(WEB_PUSH_PLUGIN_ID, { subject: 'mailto:me@example.com', publicKey: 'BPUB' });
        await reg().setSecret(VAPID_PRIVATE_KEY_SECRET, 'k');
        expect(await readiness()).toBe('ready');
    });

    it('refuses a contact that is not a URL', async () => {
        app = testActorApp([Registry, AuditActor]);
        await app.start();
        await expect(reg().configure(WEB_PUSH_PLUGIN_ID, { subject: 'me at example', publicKey: 'BPUB' })).rejects.toThrow(/subject/);
    });
});

describe('webPushChannelPlugin', () => {
    const notification = { id: 'n_1', kind: 'approval' as const, title: 'Approve?', at: 0, read: false, deliveries: [] };
    const target = (subscriptions = [{ ...SUB, addedAt: 0 }]) => ({ workspaceId: WS, subscriptions });

    it('with no subscription it opens no secret and sends nothing', async () => {
        let opened = 0;
        const sent: string[] = [];
        const channel = webPushChannelPlugin({ fetch: (async (url: string) => { sent.push(url); return new Response(null, { status: 201 }); }) as typeof fetch }).open({
            config: { subject: 'mailto:me@example.com', publicKey: 'BPUB' },
            secret: async () => { opened += 1; return 'k'; }
        });
        expect(channel.id).toBe(WEB_PUSH_CHANNEL);
        expect(await channel.deliver(notification, target([]))).toEqual({ ok: true });
        expect(opened).toBe(0);
        expect(sent).toEqual([]);
    });

    it('without a contact, a public key or the private key it reports what is missing and sends nothing', async () => {
        const sent: string[] = [];
        const fetch = (async (url: string) => { sent.push(url); return new Response(null, { status: 201 }); }) as typeof globalThis.fetch;
        const noConfig = await webPushChannelPlugin({ fetch }).open({ config: {}, secret: async () => 'k' }).deliver(notification, target());
        expect(noConfig).toMatchObject({ ok: false });
        expect(noConfig.error).toMatch(/a contact and a public key/);
        const { publicKey } = await vapidPair();
        const noKey = await webPushChannelPlugin({ fetch }).open({ config: { subject: 'mailto:me@example.com', publicKey }, secret: async () => undefined }).deliver(notification, target());
        expect(noKey.error).toMatch(/no vapid-private-key/);
        expect(sent).toEqual([]);
    });

    it('a contact that is not mailto:/https:, or a public key that is not a P-256 point, is reported before anything is signed or sent', async () => {
        const keys = await vapidPair();
        let opened = 0;
        const sent: string[] = [];
        const fetch = (async (url: string) => { sent.push(url); return new Response(null, { status: 201 }); }) as typeof globalThis.fetch;
        const deliver = (config: Record<string, unknown>) =>
            webPushChannelPlugin({ fetch }).open({ config, secret: async () => { opened += 1; return keys.privateKey; } }).deliver(notification, target());

        const ftp = await deliver({ subject: 'ftp://me.example', publicKey: keys.publicKey });
        expect(ftp).toMatchObject({ ok: false });
        expect(ftp.error).toMatch(/contact must be a mailto: or https: address/);
        const short = await deliver({ subject: 'mailto:me@example.com', publicKey: 'BPUB' });
        expect(short.error).toMatch(/public key is not a base64url P-256 point/);
        expect(opened).toBe(0);
        expect(sent).toEqual([]);

        // Surrounding whitespace is not a mistake worth failing a push over.
        expect(await deliver({ subject: '  mailto:me@example.com ', publicKey: ` ${keys.publicKey} ` })).toEqual({ ok: true });
    });

    it('signs each push with the configured key pair', async () => {
        const keys = await vapidPair();
        const requests: { url: string; auth: string }[] = [];
        const fetch = (async (url: string, init: RequestInit) => {
            requests.push({ url, auth: (init.headers as Record<string, string>).Authorization! });
            return new Response(null, { status: 201 });
        }) as typeof globalThis.fetch;
        const result = await webPushChannelPlugin({ fetch })
            .open({ config: { subject: 'mailto:me@example.com', publicKey: keys.publicKey }, secret: async () => keys.privateKey })
            .deliver(notification, target());
        expect(result).toEqual({ ok: true });
        expect(requests).toHaveLength(1);
        expect(requests[0]!.auth).toMatch(new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${keys.publicKey}$`));
    });
});
