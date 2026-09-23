/**
 * Web Push over the real wire (#244): "Generate keys" on the plugin's page
 * stores a pair the platform can sign with — public key in the config,
 * private key sealed and shown nowhere — and replacing it drops the browsers
 * subscribed with the old one. Settings → Notifications says what push still
 * needs, and lists and removes subscribed browsers; this test DOM has no
 * `PushManager`, so it says so instead of offering to subscribe.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    AuditActor,
    Inbox,
    VAPID_PRIVATE_KEY_SECRET,
    WEB_PUSH_PLUGIN_ID,
    auditKey,
    defineRegistry,
    generateWorkspaceKek,
    importWorkspaceKek,
    inboxKey,
    registryKey,
    vapidSigner,
    webPushPlugin
} from '@agentic/platform';
import { WS, mountLive, owner, startLive, tick, until, type LiveHarness } from './live-harness';

const KEK = generateWorkspaceKek();
const Registry = defineRegistry({ kek: () => importWorkspaceKek(KEK), catalogue: [{ manifest: webPushPlugin, enabledByDefault: false }] });
const CONTACT = 'mailto:me@example.com';
const SUB = { endpoint: 'https://push.example/sub/old', keys: { p256dh: 'p', auth: 'a' }, label: 'Chrome on Windows' };

let h: LiveHarness;
beforeEach(async () => {
    h = await startLive(undefined, { actors: [Registry] });
});
afterEach(async () => {
    await h.stop();
});

const registry = () => h.app.as(owner).actor(Registry, registryKey(WS));
const inbox = () => h.app.as(owner).actor(Inbox, inboxKey(WS));
const plugin = async () => (await registry().overview()).plugins.find((p) => p.manifest.id === WEB_PUSH_PLUGIN_ID)!;
const generate = (dom: ParentNode) => dom.querySelector<HTMLButtonElement>('[data-plugin-panel="generate-keys"] button');

describe('/plugins/agentic.notify.web-push (live)', () => {
    it('Generate keys without a contact fills in the default one', async () => {
        const dom = await mountLive(`/plugins/${WEB_PUSH_PLUGIN_ID}`, h);
        await until(() => generate(dom)?.disabled === false, 'the button, with no contact saved');
        generate(dom)!.click();
        await until(async () => (await registry().overview()).secretNames.includes(VAPID_PRIVATE_KEY_SECRET), 'the private key, sealed');
        expect((await plugin()).config.subject).toMatch(/^(https:|mailto:)/);
    }, 20_000);

    it('Generate keys stores a pair the platform signs with — the private key shown nowhere', async () => {
        await registry().configure(WEB_PUSH_PLUGIN_ID, { subject: CONTACT });
        const dom = await mountLive(`/plugins/${WEB_PUSH_PLUGIN_ID}`, h);
        await until(() => generate(dom)?.disabled === false, 'the button');
        generate(dom)!.click();
        await until(async () => (await registry().overview()).secretNames.includes(VAPID_PRIVATE_KEY_SECRET), 'the private key, sealed');
        await until(() => dom.querySelector('[data-plugin-panel="generate-keys"] [data-plugin-saved]') !== null, 'the saved note');

        const publicKey = (await plugin()).config.publicKey as string;
        expect(publicKey).toMatch(/^[\w-]{87}$/);
        expect((await plugin()).config.subject).toBe(CONTACT);

        // The pair is one pair: the sealed private key signs a token for the saved public key.
        await registry().enable(WEB_PUSH_PLUGIN_ID);
        const privateKey = await registry().openSecret(VAPID_PRIVATE_KEY_SECRET, WEB_PUSH_PLUGIN_ID);
        await expect(vapidSigner({ subject: CONTACT, publicKey, privateKey }).authorization('https://push.example', Date.now())).resolves.toMatch(/^vapid t=/);

        await tick();
        expect(dom.innerHTML).not.toContain(privateKey);
        expect(JSON.stringify(await plugin())).not.toContain(privateKey);
        expect(JSON.stringify(await h.app.as(owner).actor(AuditActor, auditKey(WS)).list())).not.toContain(privateKey);
    }, 20_000);

    it('replacing the keys takes a second click and drops the browsers subscribed with the old pair', async () => {
        await registry().configure(WEB_PUSH_PLUGIN_ID, { subject: CONTACT, publicKey: 'BOLD' });
        await registry().setSecret(VAPID_PRIVATE_KEY_SECRET, 'old-private');
        await inbox().subscribe(SUB);
        const dom = await mountLive(`/plugins/${WEB_PUSH_PLUGIN_ID}`, h);
        await until(() => generate(dom)?.disabled === false, 'the button');

        generate(dom)!.click();
        await until(() => /Replace the keys/.test(generate(dom)!.textContent ?? ''), 'the confirm step');
        expect((await plugin()).config.publicKey).toBe('BOLD');

        generate(dom)!.click();
        await until(async () => (await plugin()).config.publicKey !== 'BOLD', 'the new public key');
        await until(async () => (await inbox().subscriptions()).length === 0, 'the old subscriptions dropped');
        await until(() => /1 subscribed browser removed/.test(dom.textContent ?? ''), 'the note saying so');
    }, 20_000);
});

describe('/settings, push (live)', () => {
    const turnOn = (dom: ParentNode) => [...dom.querySelectorAll<HTMLButtonElement>('[data-push-setup] button')].find((b) => /Turn on push/.test(b.textContent ?? ''));

    it('one click from off: enabled, a contact and a key pair', async () => {
        const dom = await mountLive('/settings', h);
        const push = () => dom.querySelector<HTMLElement>('[data-push-devices]');
        await until(() => turnOn(dom) !== undefined, 'the Turn on button');
        expect(push()!.querySelector(`a[href="/plugins/${WEB_PUSH_PLUGIN_ID}"]`)).not.toBeNull();

        turnOn(dom)!.click();
        await until(() => push()?.getAttribute('data-push-state') === 'ready', 'push, ready');
        const p = await plugin();
        expect(p.enabled).toBe(true);
        expect(p.config.subject).toMatch(/^(https:|mailto:)/);
        expect(p.config.publicKey).toMatch(/^[\w-]{87}$/);
        // This test DOM has no PushManager: the workspace is set up, this browser is not subscribed.
        expect(await inbox().subscriptions()).toEqual([]);
    }, 20_000);

    it('without WORKSPACE_KEK it names the fix and offers no button', async () => {
        await h.stop();
        const NoKek = defineRegistry({ catalogue: [{ manifest: webPushPlugin, enabledByDefault: false }] });
        h = await startLive(undefined, { actors: [NoKek] });
        const dom = await mountLive('/settings', h);
        await until(() => /WORKSPACE_KEK/.test(dom.querySelector('[data-push-devices]')?.textContent ?? ''), 'the no-kek note');
        expect(turnOn(dom)).toBeUndefined();
    }, 20_000);

    it('says what push still needs, then lists subscribed browsers and removes one; without PushManager it offers no subscribe', async () => {
        await inbox().subscribe(SUB);
        const dom = await mountLive('/settings', h);
        const push = () => dom.querySelector<HTMLElement>('[data-push-devices]');
        await until(() => push()?.getAttribute('data-push-state') === 'off', 'push, off');
        expect(push()!.querySelector(`a[href="/plugins/${WEB_PUSH_PLUGIN_ID}"]`)).not.toBeNull();

        await registry().configure(WEB_PUSH_PLUGIN_ID, { subject: CONTACT, publicKey: 'BPUB' });
        await registry().enable(WEB_PUSH_PLUGIN_ID);
        await until(() => push()?.getAttribute('data-push-state') === 'needs-keys', 'push, needing the private key');
        expect(push()!.textContent).toContain('the private key');

        await registry().setSecret(VAPID_PRIVATE_KEY_SECRET, 'k');
        await until(() => push()?.getAttribute('data-push-state') === 'ready', 'push, ready');
        await until(() => /cannot take push/.test(push()!.textContent ?? ''), 'the no-PushManager note');
        expect([...push()!.querySelectorAll('button')].some((b) => /Get push/.test(b.textContent ?? ''))).toBe(false);

        const row = () => push()!.querySelector('[data-push-list] li');
        await until(() => row() !== null, 'the subscribed browser');
        expect(row()!.textContent).toContain('Chrome on Windows');
        row()!.querySelector('button')!.click();
        await until(async () => (await inbox().subscriptions()).length === 0, 'the subscription removed');
        await until(() => row() === null, 'the row gone');
    }, 20_000);
});
