/**
 * `/plugins/connectors/add` (#639; PLG-01, PLG-04, AGT-02): browse the installable connectors by category and
 * search, preview one from `?selected=`, connect it, then add it to the agents you pick — none by default. On mock
 * data the whole flow runs in the page; over the real wire Connect turns the plugin on and leaves for the sign-in
 * route with `?next=agents`, and the agent step writes one new config version per agent and grants nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineApp } from 'sigx';
import '@sigx/runtime-dom';
import { RouterView, type Router } from '@sigx/router';
import type { AgentId } from '@agentic/core';
import { gmailConnectorPlugin } from '@agentic/connectors';
import { AgentActor, agentKey, defineRegistry, generateWorkspaceKek, importWorkspaceKek, registryKey } from '@agentic/platform';
import { anthropicApiPlugin } from '@agentic/runtimes';
import { plainCodeRenderer, useCodeRenderer } from '@agentic/ui';
import { afterConnect } from '../../src/connectors/routes';
import { createServerRouter } from '../../src/router';
import { LiveAddConnector } from '../../src/pages/plugins/add/live';
import { addHref, addedReason, configWithConnector, parseAddQuery, withConnector } from '../../src/pages/plugins/add/model';
import { buttonNamed, setText, text, tick } from './helpers';
import { WS, mountLive, owner, tick as sleep, startLive, until, type LiveHarness } from './live-harness';

const closers: (() => void)[] = [];
afterEach(() => {
    for (const close of closers.splice(0).reverse()) close();
});

/** Mount a route on mock data, keeping the router so a test can read where the page went. */
async function mountMock(path: string): Promise<{ dom: HTMLDivElement; router: Router }> {
    const router = createServerRouter(path);
    await router.isReady();
    const dom = document.createElement('div');
    document.body.appendChild(dom);
    const app = defineApp(<RouterView />);
    app.use(router);
    app.defineProvide(useCodeRenderer, () => plainCodeRenderer);
    app.mount(dom);
    await tick();
    closers.push(() => {
        app.unmount();
        dom.remove();
    });
    return { dom, router };
}

const wait = async (check: () => boolean, what: string): Promise<void> => until(check, what, 3_000);
const urlOf = (router: Router): string => router.currentRoute.fullPath;
const tile = (dom: ParentNode, id: string) => dom.querySelector<HTMLButtonElement>(`[data-add-main] button[data-connector="${id}"]`);
const tiles = (dom: ParentNode) => [...dom.querySelectorAll<HTMLElement>('[data-add-main] button[data-connector]')].map((t) => t.getAttribute('data-connector'));
const preview = (dom: ParentNode) => dom.querySelector<HTMLElement>('[data-add-preview]');
const popup = (dom: ParentNode) => dom.querySelector<HTMLElement>('[data-scope="dialog"][data-part="popup"][data-state="open"]');
const agentBoxes = (dom: ParentNode) => [...dom.querySelectorAll<HTMLInputElement>('[data-add-agents] input[type="checkbox"]')];

describe('Add connector: the URL is the state', () => {
    it('parses what it knows, drops the rest, and writes %20 (never +)', () => {
        expect(parseAddQuery({ category: 'dev-tools', q: 'send email', show: 'not-connected', selected: 'gmail', next: 'agents', plugin: 'acme', junk: 'x' })).toEqual({ category: 'dev-tools', q: 'send email', show: 'not-connected', selected: 'gmail', next: 'agents', plugin: 'acme' });
        expect(parseAddQuery({ category: 'nope', show: 'maybe', next: 'later' })).toEqual({});
        expect(addHref({ q: 'send email', selected: 'gmail' })).toBe('/plugins/connectors/add?q=send%20email&selected=gmail');
        expect(addHref()).toBe('/plugins/connectors/add');
    });

    it('an agent config gets the connector appended once, with the reason the step writes', () => {
        expect(withConnector([{ id: 'github' }], 'gmail')).toEqual([{ id: 'github' }, { id: 'gmail' }]);
        expect(withConnector([{ id: 'gmail' }], 'gmail')).toBeNull();
        expect(configWithConnector({ connectors: [] } as never, 'gmail')).toEqual({ connectors: [{ id: 'gmail' }] });
        expect(addedReason('Gmail')).toBe('Added Gmail from Plugins');
    });

    it('the sign-in callback keeps next=agents: it lands on the agent step, otherwise on the plugin page', () => {
        expect(afterConnect('/plugins/gmail?next=agents', 'gmail')).toBe('/plugins/connectors/add?selected=gmail&next=agents');
        expect(afterConnect('/plugins/gmail', 'gmail')).toBe('/plugins/gmail');
    });
});

describe('/plugins/connectors/add (mock)', () => {
    it('three columns: categories with counts, one section per category with three tiles and See all, the empty preview', async () => {
        const { dom } = await mountMock('/plugins/connectors/add');
        const page = dom.querySelector<HTMLElement>('[data-page="connector-add"]')!;
        expect(page.getAttribute('aria-label')).toBe('Add a connector');
        const counts = Object.fromEntries([...page.querySelectorAll('[data-category-menu] a[data-category]')].map((a) => [a.getAttribute('data-category'), a.querySelector('[data-count]')!.textContent]));
        expect(counts.all).toBe('16');
        expect(counts['dev-tools']).toBe('3');
        expect(page.querySelector('[data-category="all"]')!.getAttribute('aria-current')).toBe('page');
        const sections = [...page.querySelectorAll<HTMLElement>('[data-add-section]')];
        expect(sections.map((s) => s.getAttribute('data-add-section'))).toEqual(['email-calendar', 'files-docs', 'chat', 'dev-tools', 'project-tracking', 'data']);
        const data = page.querySelector('[data-add-section="data"]')!;
        expect(data.querySelectorAll('button[data-connector]')).toHaveLength(3);
        expect(data.querySelector('a')!.textContent).toBe('See all 5');
        expect(data.querySelector('a')!.getAttribute('href')).toBe('/plugins/connectors/add?category=data');
        expect(text(page.querySelector('[data-add-head] h1'))).toBe('Add a connector');
        expect(page.querySelector<HTMLAnchorElement>('[data-add-head] a')!.getAttribute('href')).toBe('/plugins?kind=connector');
        expect(buttonNamed(page, 'Add MCP server')).toBeTruthy();
        expect(preview(page)!.hasAttribute('data-empty')).toBe(true);
    });

    it('"send email" finds Gmail — from the URL and from typing', async () => {
        const { dom, router } = await mountMock('/plugins/connectors/add?q=send%20email');
        expect(tiles(dom)).toEqual(['gmail']);
        expect(dom.querySelector('[data-add-section]')).toBeNull();

        const input = dom.querySelector<HTMLInputElement>('[data-search-field] input')!;
        setText(input, 'atlassian');
        await wait(() => tiles(dom).join() === 'jira', 'the search');
        expect(urlOf(router)).toBe('/plugins/connectors/add?q=atlassian');
        setText(input, 'send email');
        await wait(() => tiles(dom).join() === 'gmail', 'Gmail');
    });

    it('a category is a flat grid of all of it; Not connected hides what is connected', async () => {
        const { dom, router } = await mountMock('/plugins/connectors/add?category=dev-tools');
        expect(tiles(dom)).toEqual(['github', 'sentry', 'hugging-face']);
        buttonNamed(dom, 'Not connected').click();
        await wait(() => !tiles(dom).includes('github'), 'GitHub hidden');
        expect(urlOf(router)).toBe('/plugins/connectors/add?category=dev-tools&show=not-connected');
        expect(dom.querySelector('[data-category="dev-tools"] [data-count]')!.textContent).toBe('2');
    });

    it('selecting a tile shows its preview, and the URL restores it on reload', async () => {
        const { dom, router } = await mountMock('/plugins/connectors/add');
        tile(dom, 'gmail')!.click();
        await wait(() => preview(dom)?.getAttribute('data-connector') === 'gmail', 'the preview');
        expect(urlOf(router)).toBe('/plugins/connectors/add?selected=gmail');
        expect(tile(dom, 'gmail')!.getAttribute('aria-pressed')).toBe('true');

        const reloaded = (await mountMock(urlOf(router))).dom;
        const p = preview(reloaded)!;
        expect(p.getAttribute('data-connector')).toBe('gmail');
        expect(text(p.querySelector('h2'))).toBe('Gmail');
        expect(text(p.querySelector('[data-preview-meta] > :first-child'))).toBe('conduit');
        expect(text(p.querySelector('[data-preview-meta] code'))).toBe('built in · 1.0.0');
        const tools = [...p.querySelectorAll('[data-preview-group="tools"] li')];
        expect(tools).toHaveLength(9);
        expect(tools.filter((li) => li.hasAttribute('data-asks')).map((li) => li.getAttribute('data-tool'))).toEqual(['send-email', 'reply-to-message', 'trash-message']);
        expect(text(p.querySelector('[data-preview-group="asks"]'))).toContain('Sign in with Google');
        expect(text(p.querySelector('[data-preview-group="asks"]'))).toContain('network:gmail.googleapis.com');
        expect(text(p.querySelector('[data-preview-group="runs-on"] p'))).toBe('The platform. No machine needed.');
        expect(buttonNamed(p, 'Connect Gmail')).toBeTruthy();
    });

    it('a connected tile is dimmed and opens its plugin page', async () => {
        const { dom, router } = await mountMock('/plugins/connectors/add');
        const github = tile(dom, 'github')!;
        expect(github.hasAttribute('data-connected')).toBe(true);
        github.click();
        await wait(() => urlOf(router) === '/plugins/github', 'the plugin page');
    });

    it('connecting Gmail reaches the agent step with nothing picked; Skip lands on the plugin page', async () => {
        const { dom, router } = await mountMock('/plugins/connectors/add?selected=gmail');
        buttonNamed(preview(dom)!, 'Connect Gmail').click();
        await wait(() => dom.querySelector('[data-add-step="agents"]') !== null, 'the agent step');
        expect(urlOf(router)).toBe('/plugins/connectors/add?selected=gmail&next=agents');
        expect(text(dom.querySelector('[data-add-step] h1'))).toBe('Choose agents for Gmail');
        const boxes = agentBoxes(dom);
        expect(boxes.map((b) => b.value)).toEqual(['atlas', 'forge', 'lint', 'scout']);
        expect(boxes.some((b) => b.checked)).toBe(false);
        expect(buttonNamed(dom, 'Add to agents').disabled).toBe(true);

        boxes[0]!.click();
        await wait(() => buttonNamed(dom, 'Add to 1 agent').disabled === false, 'Save enabled');
        buttonNamed(dom, 'Skip').click();
        await wait(() => urlOf(router) === '/plugins/gmail', 'the plugin page');
    });

    it('an MCP listing opens the MCP form prefilled with its name, URL and credential kind', async () => {
        const { dom } = await mountMock('/plugins/connectors/add?selected=sentry');
        expect(text(preview(dom)!.querySelector('[data-preview-group="tools"]'))).toContain('The server lists its own tools');
        buttonNamed(preview(dom)!, 'Connect Sentry').click();
        await wait(() => popup(dom) !== null, 'the form');
        const form = popup(dom)!;
        await wait(() => form.querySelector<HTMLInputElement>('input[name="connector-name"]')!.value === 'Sentry', 'the prefilled name');
        expect(form.querySelector<HTMLInputElement>('input[name="connector-url"]')!.value).toBe('https://mcp.sentry.dev/mcp');
        expect(form.querySelector<HTMLSelectElement>('select[name="connector-auth"]')!.value).toBe('header');
        expect(form.querySelector<HTMLInputElement>('input[name="connector-header"]')!.value).toBe('Authorization');
        expect(form.querySelector<HTMLInputElement>('input[name="connector-secret"]')!.value).toBe('');
    });
});

const KEK = generateWorkspaceKek();
const Registry = defineRegistry({ kek: () => importWorkspaceKek(KEK), catalogue: [anthropicApiPlugin, { manifest: gmailConnectorPlugin, enabledByDefault: false }] });

describe('/plugins/connectors/add (live)', () => {
    let h: LiveHarness;
    beforeEach(async () => {
        h = await startLive(undefined, { actors: [Registry] });
    });
    afterEach(async () => {
        await h.stop();
    });
    const registry = () => h.app.as(owner).actor(Registry, registryKey(WS));

    it('Connect turns Gmail on and leaves for the sign-in route with next=agents', async () => {
        expect((await registry().get('gmail'))!.enabled).toBe(false);
        const went: string[] = [];
        const dom = await mountLive('/plugins/connectors/add?selected=gmail', h, <LiveAddConnector navigate={(href: string) => { went.push(href); }} />);
        await wait(() => preview(dom)?.getAttribute('data-connector') === 'gmail', 'the preview');
        buttonNamed(preview(dom)!, 'Connect Gmail').click();
        await wait(() => went.length === 1, 'the sign-in');
        expect(went).toEqual(['/_agentic/connectors/gmail/start?next=agents']);
        expect((await registry().get('gmail'))!.enabled).toBe(true);
    });

    it('choosing Atlas writes one new Atlas config version that lists gmail, and no grant changes', async () => {
        const atlas = await h.agent('Atlas', 'Personal assistant');
        const forge = await h.agent('Forge');
        await registry().enable('gmail');
        const agent = (id: AgentId) => h.app.as(owner).actor(AgentActor, agentKey(WS, id));
        const before = { atlas: await agent(atlas).listVersions(), forge: await agent(forge).listVersions(), plugins: (await registry().overview()).plugins };

        const dom = await mountLive('/plugins/connectors/add?selected=gmail&next=agents&connected=1', h);
        await wait(() => agentBoxes(dom).length === 2, 'the agents');
        expect(agentBoxes(dom).some((b) => b.checked)).toBe(false);
        agentBoxes(dom).find((b) => b.value === atlas)!.click();
        await tick();
        buttonNamed(dom, 'Add to 1 agent').click();
        await until(async () => (await agent(atlas).listVersions()).length === before.atlas.length + 1, 'the new version');

        const versions = await agent(atlas).listVersions();
        expect(versions.at(-1)!.reason).toBe('Added Gmail from Plugins');
        expect((await agent(atlas).get()).config.connectors).toEqual([{ id: 'gmail' }]);
        // Forge was not picked; nothing is granted by the page.
        expect(await agent(forge).listVersions()).toEqual(before.forge);
        expect((await registry().overview()).plugins.map((p) => [p.manifest.id, p.enabled, p.grantedPermissions])).toEqual(before.plugins.map((p) => [p.manifest.id, p.enabled, p.grantedPermissions]));
        await sleep(50);
        expect((await agent(atlas).listVersions()).length).toBe(before.atlas.length + 1);
    });
});
