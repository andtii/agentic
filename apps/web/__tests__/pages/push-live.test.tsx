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
    it('Generate keys waits for a contact, then stores a pair the platform signs with — the private key shown nowhere', async () => {
        const dom = await mountLive(`/plugins/${WEB_PUSH_PLUGIN_ID}`, h);
        await until(() => generate(dom) !== null, 'the key pair panel');
        expect(generate(dom)!.disabled).toBe(true);
        expect(dom.querySelector('[data-plugin-panel="generate-keys"]')!.textContent).toMatch(/Save a contact/);

        await registry().configure(WEB_PUSH_PLUGIN_ID, { subject: CONTACT });
        await until(() => generate(dom)?.disabled === false, 'the button, once the contact is saved');
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
