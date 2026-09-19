/**
 * "Add A2A peer" on `/plugins` over the real wire (#246): the dialog refuses a
 * draft without a name or a URL, then stores the token as the peer's secret
 * and the peer as a runtime plugin `a2a.<id>` — on, granted what it declares —
 * which the live catalogue lists with the runtimes and the agent form offers.
 * The token is shown nowhere.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentId } from '@agentic/core';
import { AgentActor, agentKey, defineRegistry, generateWorkspaceKek, importWorkspaceKek, registryKey } from '@agentic/platform';
import { RUNTIME_PLUGINS } from '@agentic/runtimes';
import { EMPTY_PEER_DRAFT, peerDraftErrors, peerRuntimeId, peerSetup } from '../../src/pages/plugins/a2a-peer';
import { buttonNamed, setText, text } from './helpers';
import { WS, mountLive, owner, startLive, until, type LiveHarness } from './live-harness';

const KEK = generateWorkspaceKek();
const Registry = defineRegistry({ kek: () => importWorkspaceKek(KEK), catalogue: [...RUNTIME_PLUGINS] });
const TOKEN = 'peer-token-NEVER-SHOWN-41b7';

describe('the Add A2A peer draft', () => {
    it('needs a name that makes a new id and an http(s) URL', () => {
        expect(peerDraftErrors(EMPTY_PEER_DRAFT, [])).toEqual({ name: 'Give the peer a name.', cardUrl: "Paste the agent card URL, or the agent's base URL." });
        expect(peerDraftErrors({ name: '!!', cardUrl: 'ftp://x', token: '' }, [])).toEqual({ name: 'Use at least one letter or digit.', cardUrl: 'That is not an http(s) URL.' });
        expect(peerDraftErrors({ name: 'Research Bot', cardUrl: 'https://r.example.com', token: '' }, ['a2a.research-bot'])).toEqual({ name: 'There is already a peer called research-bot.' });
        expect(peerDraftErrors({ name: 'Research Bot', cardUrl: 'https://r.example.com', token: '' }, [])).toEqual({});
        expect(peerRuntimeId({ name: 'Research Bot', cardUrl: '', token: '' })).toBe('a2a.research-bot');
    });

    it('stores a runtime manifest, and the token only when there is one', () => {
        const { manifest, secret } = peerSetup({ name: ' Research Bot ', cardUrl: 'https://r.example.com/a2a/x', token: ' t0k ' });
        expect(manifest).toMatchObject({ id: 'a2a.research-bot', kind: 'runtime', name: 'Research Bot', config: { properties: { cardUrl: { default: 'https://r.example.com/a2a/x' } } } });
        expect(secret).toEqual({ name: 'a2a-research-bot-token', value: 't0k' });
        expect(peerSetup({ name: 'x', cardUrl: 'https://r.example.com', token: '  ' }).secret).toBeUndefined();
    });
});

let h: LiveHarness;
beforeEach(async () => {
    h = await startLive(undefined, { actors: [Registry] });
});
afterEach(async () => {
    await h.stop();
});

const registry = () => h.app.as(owner).actor(Registry, registryKey(WS));
const card = (dom: ParentNode, id: string) => dom.querySelector<HTMLElement>(`[data-scope="ag-plugin-card"][data-part="root"][data-plugin="${id}"]`);
const field = (name: string) => document.querySelector<HTMLInputElement>(`[data-a2a-peer-fields] input[name="${name}"]`);

describe('/plugins: Add A2A peer (live)', () => {
    it('refuses an empty draft, then adds the peer as a runtime with its token sealed — listed, offered to agents, never shown', async () => {
        const dom = await mountLive('/plugins', h);
        await until(() => card(dom, 'anthropic-api') !== null, 'the catalogue');
        buttonNamed(dom, 'Add A2A peer').click();
        await until(() => field('peer-name') !== null, 'the dialog');

        buttonNamed(document, 'Add peer').click();
        await until(() => text(document.querySelector('[data-a2a-peer-fields]')).includes('Give the peer a name.'), 'the refusal');
        expect((await registry().list()).some((p) => p.manifest.id.startsWith('a2a.'))).toBe(false);

        setText(field('peer-name')!, 'Research Bot');
        setText(field('peer-card-url')!, 'https://research.example.com/.well-known/agent-card.json');
        setText(field('peer-token')!, TOKEN);
        buttonNamed(document, 'Add peer').click();
        await until(() => card(dom, 'a2a.research-bot') !== null, 'the peer on the catalogue');

        const peer = (await registry().list()).find((p) => p.manifest.id === 'a2a.research-bot')!;
        expect(peer).toMatchObject({ enabled: true, manifest: { kind: 'runtime', name: 'Research Bot' } });
        expect(peer.grantedPermissions).toEqual(['network:research.example.com', 'secret:a2a-research-bot-token']);
        expect((await registry().secrets()).map((s) => s.name)).toContain('a2a-research-bot-token');
        expect(card(dom, 'a2a.research-bot')!.closest('[data-plugin-group]')!.getAttribute('data-plugin-group')).toBe('runtime:remote');
        expect(text(dom.querySelector('[data-a2a-peer-added]'))).toContain('Added Research Bot');
        expect(document.body.innerHTML).not.toContain(TOKEN);
    }, 20_000);

    it('the agent form offers the peer as a runtime', async () => {
        await registry().register(peerSetup({ name: 'Research Bot', cardUrl: 'https://research.example.com', token: '' }).manifest, { enabled: true, grant: 'declared' });
        const id = 'atlas' as AgentId;
        await h.app.as(owner).actor(AgentActor, agentKey(WS, id)).update({ name: 'Atlas', instructions: 'x', execution: { runtime: 'anthropic-api', offlinePolicy: 'fail' } }, 'create');
        const dom = await mountLive(`/agents/${id}?tab=config`, h);
        const select = () => dom.querySelector<HTMLSelectElement>('form[data-form="agent"] select[name="runtime"]');
        await until(() => [...(select()?.options ?? [])].some((o) => o.value === 'a2a.research-bot'), 'the peer in the runtime list');
        expect(text([...select()!.options].find((o) => o.value === 'a2a.research-bot'))).toBe('Research Bot');
    }, 20_000);
});
