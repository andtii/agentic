/**
 * Loading and polish on Requests, Links and Settings › Project manager (#942): skeleton rows while the first read is
 * out (not the empty state), one-line row titles with the whole title as the tooltip, the `why you:` line for a
 * request held back or with no manager, ages told in the workspace zone, Links read live (a change in any project's
 * plan redraws the graph without a reload), the skill picker's catalogue, and sender rules that name members.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PM_POLICY_DEFAULT, type AgentId, type ProjectId, type ProjectRecord, type ProjectRequest } from '@agentic/core';
import { definePlanActor, planKey, type LinkItemInput, type RequestView } from '@agentic/platform';
import { clientDefs } from '../../src/actors/client';
import { mockSettingsSaves } from '../../src/mock/projects/settings';
import { PROJECTS } from '../../src/mock/workspace';
import { LinksBoard } from '../../src/pages/projects/links/Links';
import { linkGraphsOf } from '../../src/pages/projects/links/live';
import { saveProjectWith } from '../../src/pages/projects/live';
import { liveEntries } from '../../src/pages/projects/requests/live';
import { whyYou, type RequestEntry } from '../../src/pages/projects/requests/model';
import { RequestsView } from '../../src/pages/projects/requests/RequestsView';
import { addSenderProject, policyDraftOf, policyOf, senderMembers, skillCatalogOf, whoLabel } from '../../src/pages/projects/settings/manager/model';
import { mountAt, text } from '../pages/helpers';
import { mountRoute, tick } from '../pages/mount';
import { USER, WS, mountLive, owner, startLive, until, type LiveHarness } from '../pages/live-harness';

const PROJECT = PROJECTS[0]! as ProjectRecord;
const DAY = 24 * 3600_000;
const NOW = Date.UTC(2026, 8, 20, 12, 0);

const request = (over: Partial<ProjectRequest> = {}): ProjectRequest => ({
    id: 'req_1', fromProject: 'p_signalx' as ProjectId, toProject: PROJECT.id, sender: { kind: 'agent', agentId: 'forge' as AgentId },
    title: 'batch() drops nested effects when the inner effect throws during a flush', body: 'Found while testing.', refs: [],
    state: 'needs-you', createdAt: NOW - 3 * DAY, updatedAt: NOW - 3 * DAY, ...over
});
const entry = (over: Partial<RequestEntry> = {}, r: Partial<ProjectRequest> = {}): RequestEntry => ({ request: request(r), box: 'incoming', fromProjectName: 'SignalX', toProjectName: 'agentic', ...over });

const view = (entries: readonly RequestEntry[], extra: { loading?: boolean; zone?: string } = {}) => (
    <RequestsView project={PROJECT} entries={entries} manager="Atlas" names={(id: string) => ({ name: id })} you="you" phases={[]} now={NOW}
        {...extra} onAccept={() => {}} onAskForMore={() => {}} onDecline={() => {}} />
);

describe('Requests: skeletons, titles, why you, zone (#942)', () => {
    it('shows skeleton rows while loading, and the empty state only once the read has landed', async () => {
        const loading = await mountAt('/projects/p_agentic/requests', view([], { loading: true }));
        expect(loading.querySelector('[data-requests-list] [data-skeleton]')).not.toBeNull();
        expect(loading.querySelector('[data-requests-list] [data-requests-empty]')).toBeNull();
        const landed = await mountAt('/projects/p_agentic/requests', view([]));
        expect(landed.querySelector('[data-requests-list] [data-skeleton]')).toBeNull();
        expect(text(landed.querySelector('[data-requests-list] [data-requests-empty]'))).toBe('No requests from other projects yet.');
    });

    it('keeps a row title on one line with the whole title as its tooltip', async () => {
        const dom = await mountAt('/projects/p_agentic/requests', view([entry()]));
        const title = dom.querySelector<HTMLElement>('[data-requests-row="req_1"] [data-requests-row-title]')!;
        expect(title.getAttribute('title')).toBe(request().title);
        expect(title.style.whiteSpace).toBe('nowrap');
        expect(title.style.textOverflow).toBe('ellipsis');
        expect(title.style.overflow).toBe('hidden');
    });

    it('says why you for a request held back by the sender rules and for one with no manager', async () => {
        const live = liveEntries({
            incoming: [
                { ...request(), needs: 'admit', reasons: ['sender'] } as RequestView,
                { ...request({ id: 'req_2' }), needs: 'decision', reasons: ['no-manager'] } as RequestView,
                { ...request({ id: 'req_3', state: 'accepted', resultItem: 4 }) } as RequestView
            ],
            sent: [],
            linked: []
        }, (id) => id, 'Atlas');
        expect(live.map((e) => e.why ?? null)).toEqual(["the sender's project asks you first", 'this project has no project manager', null]);
        expect(live.map(whyYou)).toEqual(["the sender's project asks you first", 'this project has no project manager', undefined]);
        // Mock data carries no reasons: a held-back request still names the sender rule.
        expect(whyYou(entry({ needs: 'admit' }))).toBe("the sender's project asks you first");

        const admit = await mountAt('/projects/p_agentic/requests', view([live[0]!]));
        expect(text(admit.querySelector('[data-requests-triage="admit"] [data-requests-why]'))).toBe("why you: the sender's project asks you first");
        const person = await mountAt('/projects/p_agentic/requests', view([live[1]!]));
        expect(person.querySelector('[data-requests-triage="pending"]')).toBeNull();
        expect(text(person.querySelector('[data-requests-triage="person"] [data-requests-why]'))).toBe('why you: this project has no project manager');
    });

    it('tells ages in the workspace zone', async () => {
        const at = (zone: string) => mountAt('/projects/p_agentic/requests', view([entry()], { zone })).then((d) => d.querySelector('[data-requests-row-age] time')!.getAttribute('title'));
        const utc = await at('UTC');
        const kiritimati = await at('Pacific/Kiritimati');
        expect(utc).toBeTruthy();
        expect(kiritimati).not.toBe(utc);
    });
});

describe('Links: skeletons and the graphs over items in hand (#942)', () => {
    const empty = { open: { lanes: [], items: [] }, done: { lanes: [], items: [] } };

    it('shows skeleton lanes while loading, the empty state after', async () => {
        const loading = await mountAt('/projects/links', <LinksBoard data={empty} loading />);
        expect(loading.querySelector('[data-links-skeleton]')).not.toBeNull();
        expect(loading.querySelector('[data-links-skeleton]')!.getAttribute('aria-busy')).toBe('true');
        expect(text(loading)).not.toContain('No open links across projects');
        const landed = await mountAt('/projects/links', <LinksBoard data={empty} />);
        expect(landed.querySelector('[data-links-skeleton]')).toBeNull();
        expect(text(landed)).toContain('No open links across projects');
    });

    it('builds both views from each project’s items; a project without items yet counts as none', () => {
        const A = 'p_a' as ProjectId;
        const B = 'p_b' as ProjectId;
        const item = (id: number, title: string) => ({ id, title, state: 'ready' as const, after: [], touches: [], refs: [], doneWhen: [], activity: [] });
        const C = 'p_c' as ProjectId;
        const items: Record<string, LinkItemInput[]> = {
            [A]: [{ item: item(1, 'Wire it'), afterRefs: [{ projectId: B, n: 2 }], planId: 'p1', planTitle: 'Alpha 1' }],
            [B]: [{ item: item(2, 'Ship it'), planId: 'p2', planTitle: 'Beta 1' }]
        };
        const g = linkGraphsOf([{ id: A, name: 'alpha', manager: null }, { id: B, name: 'beta', manager: null }, { id: C, name: 'gamma', manager: null }], (id) => items[id]);
        expect(g.open.counts.open).toBe(1);
        expect(g.open.lanes.map((l) => l.name)).toEqual(['alpha', 'beta']);
        expect(g.done.show).toBe('done');
    });
});

describe('Links read live (#942)', () => {
    let h: LiveHarness;
    const Plan = definePlanActor();
    beforeEach(async () => {
        h = await startLive(undefined, { actors: [Plan] });
    });
    afterEach(async () => {
        await h.stop();
    });

    it('redraws when a project’s plan gains a wait on another project, without a reload', { timeout: 30_000 }, async () => {
        const forge = await h.agent('Forge', 'Builds things');
        const { id: alpha } = await saveProjectWith(clientDefs(), USER, { name: 'alpha', members: { agentIds: [forge], coordinator: forge }, folders: {}, connectors: [], features: {} });
        const { id: beta } = await saveProjectWith(clientDefs(), USER, { name: 'beta', members: { agentIds: [forge], coordinator: forge }, folders: {}, connectors: [], features: {} });
        const plan = (p: string) => h.app.as(owner).actor(Plan, planKey(WS, p as ProjectId));
        await plan(beta).create({ title: 'Beta 1', phases: [{ title: 'Core', items: [{ title: 'Stable ordering' }] }] });
        await plan(alpha).create({ title: 'Alpha 1', phases: [{ title: 'Core', items: [{ title: 'Adopt stable ordering' }] }] });

        const dom = await mountLive('/projects/links', h);
        await until(() => text(dom).includes('No open links across projects'), 'the empty graph once the read lands', 10_000);
        expect(dom.querySelector('[data-links-skeleton]')).toBeNull();

        await plan(alpha).after(1, ['beta#1']);
        await until(() => dom.querySelector('[data-links-node="alpha#1"]') !== null, 'the new link, pushed live', 10_000);
        expect(dom.querySelector('[data-links-node="beta#1"]')).not.toBeNull();
    });
});

describe('Project manager: sender rules name members, the skills catalogue (#942)', () => {
    it('adds a rule for only the members picked, and any member when none is', () => {
        const d = policyDraftOf(PM_POLICY_DEFAULT);
        addSenderProject(d, 'p_docs', ['scout', 'scout', '']);
        addSenderProject(d, 'p_other');
        expect(policyOf(d).senders).toEqual([
            { project: 'p_docs', who: [{ kind: 'agent', agentId: 'scout' }], mode: 'allowed' },
            { project: 'p_other', who: 'any-member', mode: 'allowed' },
            { project: '*', who: 'any-member', mode: 'ask' }
        ]);
        expect(senderMembers({ members: { agentIds: ['atlas', 'forge', 'atlas'] } }, (id) => id.toUpperCase())).toEqual([{ id: 'atlas', name: 'ATLAS' }, { id: 'forge', name: 'FORGE' }]);
        expect(senderMembers(undefined, (id) => id)).toEqual([]);
    });

    it('lists every skill the workspace’s agents carry, and the manager’s own, once each', () => {
        expect(skillCatalogOf([['triage', 'planning'], [], ['git-worktree', 'triage']], ['release-notes', ' '])).toEqual([
            { value: 'git-worktree', label: 'git-worktree' },
            { value: 'planning', label: 'planning' },
            { value: 'release-notes', label: 'release-notes' },
            { value: 'triage', label: 'triage' }
        ]);
    });

    it('names members in the sender-rule editor and saves them in the policy', async () => {
        mockSettingsSaves.length = 0;
        const dom = await mountRoute('/projects/p_docs/settings/manager');
        const tab = dom.querySelector<HTMLElement>('[data-settings-tab="manager"]')!;
        const add = tab.querySelector<HTMLElement>('[data-pm-sender-add]')!;
        add.querySelector<HTMLElement>('[data-scope="select"][data-part="trigger"]')!.click();
        await tick();
        [...add.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent?.replace('✓', '').trim() === 'agentic')!.click();
        for (let i = 0; i < 3; i++) await tick();
        const members = [...add.querySelectorAll('[data-pm-sender-member]')].map((m) => m.getAttribute('data-pm-sender-member'));
        expect(members).toEqual(['forge', 'lint', 'atlas']);
        for (const id of ['forge', 'atlas']) {
            add.querySelector<HTMLInputElement>(`input[role="switch"][name="pm-sender-member-${id}"]`)!.click();
            await tick();
        }
        [...add.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Add')!.click();
        for (let i = 0; i < 3; i++) await tick();
        expect(text(tab.querySelector('[data-pm-sender="p_agentic"] [data-pm-sender-who]'))).toBe('Forge and Atlas');

        [...tab.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Save policy')!.click();
        for (let i = 0; i < 3; i++) await tick();
        expect(mockSettingsSaves.at(-1)?.pmPolicy?.senders[0]).toEqual({
            project: 'p_agentic', who: [{ kind: 'agent', agentId: 'forge' }, { kind: 'agent', agentId: 'atlas' }], mode: 'allowed'
        });
        expect(whoLabel([{ kind: 'agent', agentId: 'forge' as AgentId }], (id) => id)).toBe('forge');
    });
});
