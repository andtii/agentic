/**
 * `/plugins/gmail` over the real wire (#640; PLG-03, PLG-04): the Tools panel reads `Registry.toolPolicy` live and
 * writes `setToolPolicy` — drawn at once, persisted, still there after a reload, rolled back when refused — and the
 * Granted panel's Revoke / Grant round-trips through the Registry, a `tools:` revoke only after the confirm. The
 * topbar trail names the connector once the page has read it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetchTransport } from '@sigx/actors/client';
import { gmailConnectorPlugin } from '@agentic/connectors';
import { defineRegistry, generateWorkspaceKek, importWorkspaceKek, registryKey } from '@agentic/platform';
import { anthropicApiPlugin } from '@agentic/runtimes';
import { topbarFor } from '../../src/components/topbar';
import { trailFor } from '../../src/crumbs';
import '../../src/pages/Plugin';
import { buttonNamed, text } from './helpers';
import { USER, WS, mountLive, owner, startLive, until, type LiveHarness } from './live-harness';

const KEK = generateWorkspaceKek();
const Registry = defineRegistry({ kek: () => importWorkspaceKek(KEK), catalogue: [anthropicApiPlugin, { manifest: gmailConnectorPlugin, enabledByDefault: false }] });

let h: LiveHarness;
beforeEach(async () => {
    h = await startLive(undefined, { actors: [Registry] });
});
afterEach(async () => {
    await h.stop();
});

const registry = () => h.app.as(owner).actor(Registry, registryKey(WS));
const row = (dom: ParentNode, tool: string) => dom.querySelector<HTMLElement>(`#tools [data-tool-policy="${tool}"]`);
const pressed = (dom: ParentNode, tool: string) => row(dom, tool)?.querySelector('[aria-pressed="true"]')?.textContent ?? null;
const pick = (dom: ParentNode, tool: string, mode: string) => [...row(dom, tool)!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === mode)!.click();
const isGranted = (dom: ParentNode, scope: string) => dom.querySelector(`#granted [data-permission="${scope}"]`)?.hasAttribute('data-granted') ?? null;

describe('/plugins/:id tools and grants (live)', () => {
    it('setting gmail__send-email to deny persists and shows after a reload', async () => {
        const dom = await mountLive('/plugins/gmail', h);
        await until(() => pressed(dom, 'gmail__send-email') === 'ask', 'the tool at its default mode');
        expect(pressed(dom, 'gmail__search-messages')).toBe('allow');
        expect(text(dom.querySelector('#tools [data-plugin-panel-caption]'))).toBe('workspace default; an agent’s own policy can only be stricter');

        pick(dom, 'gmail__send-email', 'deny');
        await until(async () => (await registry().toolPolicy('gmail'))['gmail__send-email'] === 'deny', 'the Registry to hold deny');
        await until(() => pressed(dom, 'gmail__send-email') === 'deny' && row(dom, 'gmail__send-email')!.getAttribute('aria-busy') === null, 'the row to settle on deny');

        // A reload: a fresh page reads it back from the Registry.
        const again = await mountLive('/plugins/gmail', h);
        await until(() => pressed(again, 'gmail__send-email') === 'deny', 'deny after a reload');
        expect(pressed(again, 'gmail__trash-message')).toBe('ask');
    }, 20_000);

    it('a refused write rolls the row back and says why', async () => {
        // The same wire, but the Registry's setToolPolicy never lands.
        const refusing = fetchTransport({
            endpoint: 'http://agentic.test/_sigx/actor',
            headers: { 'x-user': USER, origin: 'http://agentic.test' },
            fetch: async (input, init) => {
                const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
                if (url.includes('setToolPolicy') || (typeof init?.body === 'string' && init.body.includes('setToolPolicy'))) return new Response(JSON.stringify({ error: { message: 'refused' } }), { status: 500, headers: { 'content-type': 'application/json' } });
                return h.fetch(url, init);
            }
        });
        const dom = await mountLive('/plugins/gmail', { ...h, transport: refusing });
        await until(() => pressed(dom, 'gmail__trash-message') === 'ask', 'the tool');
        pick(dom, 'gmail__trash-message', 'allow');
        await until(() => dom.querySelector('[role="alert"]') !== null, 'the error');
        expect(text(dom.querySelector('[role="alert"]'))).toMatch(/^gmail__trash-message stays as it was/);
        expect(pressed(dom, 'gmail__trash-message')).toBe('ask');
        expect((await registry().toolPolicy('gmail'))['gmail__trash-message']).toBe('ask');
    }, 20_000);

    it('Revoke then Grant round-trips; revoking tools:gmail asks first', async () => {
        const dom = await mountLive('/plugins/gmail', h);
        await until(() => isGranted(dom, 'network:gmail.googleapis.com') === true, 'the grants');

        buttonNamed(dom.querySelector('#granted [data-permission="network:gmail.googleapis.com"]')!, 'Revoke').click();
        await until(() => isGranted(dom, 'network:gmail.googleapis.com') === false, 'the scope under declared');
        expect((await registry().get('gmail'))!.grantedPermissions).not.toContain('network:gmail.googleapis.com');
        buttonNamed(dom.querySelector('#granted [data-permission="network:gmail.googleapis.com"]')!, 'Grant').click();
        await until(() => isGranted(dom, 'network:gmail.googleapis.com') === true, 'the scope granted again');
        expect((await registry().get('gmail'))!.grantedPermissions).toContain('network:gmail.googleapis.com');

        buttonNamed(dom.querySelector('#granted [data-permission="tools:gmail"]')!, 'Revoke').click();
        await until(() => dom.querySelector('[role="alertdialog"]') !== null, 'the confirm');
        const dialog = dom.querySelector<HTMLElement>('[role="alertdialog"]')!;
        expect(text(dialog)).toContain('Agents lose these tools on their next session');
        // Nothing is revoked until it is confirmed.
        expect((await registry().get('gmail'))!.grantedPermissions).toContain('tools:gmail');
        buttonNamed(dialog, 'Revoke tools:gmail').click();
        await until(() => isGranted(dom, 'tools:gmail') === false, 'tools:gmail revoked');
        expect((await registry().get('gmail'))!.grantedPermissions).not.toContain('tools:gmail');
    }, 20_000);

    it('the crumb shows the plugin name', async () => {
        const route = { name: 'plugin', path: '/plugins/gmail', params: { id: 'gmail' } };
        const dom = await mountLive('/plugins/gmail', h);
        await until(() => dom.querySelector('[data-plugin-detail]') !== null, 'the page');
        await until(() => trailFor(route, topbarFor(route)).length === 3, 'the trail');
        expect(trailFor(route, topbarFor(route)).map((c) => c.label)).toEqual(['Plugins', 'Connectors', 'Gmail']);
    });
});
