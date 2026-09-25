/**
 * The Requests inbox on the platform (#831): the project's Requests actor read as incoming / sent / linked entries,
 * and a person's Let it in / Accept / Decline resolved through the store — on a real in-process host with the Plan.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AgentId, Principal, ProjectId, SessionId, Triage } from '@agentic/core';
import { definePlanActor, defineRequestsActor, NO_REQUEST_TURNS, planKey, requestsKey, type RequestView } from '@agentic/platform';
import { clientDefs } from '../../src/actors/client';
import { projectHead } from '../../src/pages/projects/head';
import { saveProjectWith } from '../../src/pages/projects/LiveProjects';
import { acceptResolution, failureNote, liveEntries, phasesOf } from '../../src/pages/projects/requests/live';
import { text } from '../pages/helpers';
import { USER, WS, mountLive, owner, startLive, tick, until, type LiveHarness } from '../pages/live-harness';

const view = (over: Partial<RequestView>): RequestView => ({
    id: 'req_1', fromProject: 'p_a' as ProjectId, toProject: 'p_b' as ProjectId, sender: { kind: 'agent', agentId: 'forge' as AgentId },
    title: 't', body: 'b', refs: [], state: 'triaging', createdAt: 1, updatedAt: 1, ...over
});

describe('the live Requests model (#831)', () => {
    const names = (id: string): string => ({ p_a: 'alpha', p_b: 'beta' })[id] ?? id;

    it('puts each read in its box, with names and the list line', () => {
        const entries = liveEntries({
            incoming: [view({ state: 'needs-you', needs: 'admit' }), view({ id: 'req_2', state: 'asked-for-more', question: 'Which version?' })],
            sent: [view({ id: 'req_3', fromProject: 'p_b' as ProjectId, toProject: 'p_x' as ProjectId, state: 'declined', declineReason: 'Not ours' })],
            linked: [{ direction: 'incoming', request: view({ id: 'req_4', state: 'accepted', resultItem: 7 }) }]
        }, names, 'Nova');
        expect(entries.map((e) => [e.request.id, e.box, e.fromProjectName, e.toProjectName, e.note ?? null, e.needs ?? null])).toEqual([
            ['req_1', 'incoming', 'alpha', 'beta', 'waiting for you to let it in', 'admit'],
            ['req_2', 'incoming', 'alpha', 'beta', 'Nova asked: Which version?', null],
            ['req_3', 'sent', 'beta', 'p_x', 'Not ours', null],
            ['req_4', 'linked', 'alpha', 'beta', null, null]
        ]);
    });

    it('accepts as proposed or edited, reads the first plan’s phases and words a refusal', () => {
        expect(acceptResolution()).toEqual({ action: 'accept' });
        const item = { title: 'x', doneWhen: [] };
        expect(acceptResolution({ item, openIssue: false })).toEqual({ action: 'accept', item, openIssue: false });
        expect(phasesOf(undefined)).toEqual([]);
        expect(phasesOf([{ phases: [{ n: 1, title: 'Core', items: [] } as never] }])).toEqual([{ n: 1, title: 'Core' }]);
        expect(failureNote('accept it', new Error('[requests] req_1 has no proposed item; give one'))).toBe('Could not accept it: req_1 has no proposed item; give one');
    });
});

describe('the Requests inbox on the live wire (#831)', () => {
    let h: LiveHarness;
    const Plan = definePlanActor();
    const Requests = defineRequestsActor({ turns: NO_REQUEST_TURNS });
    beforeEach(async () => {
        h = await startLive(undefined, { actors: [Plan, Requests] });
    });
    afterEach(async () => {
        projectHead.value = null;
        await h.stop();
    });

    const button = (root: ParentNode, label: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => text(b) === label);
    const rowState = (dom: ParentNode, id: string) => dom.querySelector(`[data-requests-row="${id}"]`)?.getAttribute('data-state');

    it('lets a held request in, accepts its triage into the plan, and declines another', { timeout: 30_000 }, async () => {
        const forge = await h.agent('Forge', 'Builds things');
        const nova = await h.agent('Nova', 'Manages');
        const { id: from } = await saveProjectWith(clientDefs(), USER, { name: 'alpha', members: { agentIds: [forge], coordinator: forge }, folders: {}, connectors: [], features: {} });
        const { id: to } = await saveProjectWith(clientDefs(), USER, { name: 'beta', members: { agentIds: [nova], coordinator: nova }, folders: {}, connectors: [], features: {} });
        const store = (p: Principal = owner) => h.app.as(p).actor(Requests, requestsKey(WS, to as ProjectId));
        const first = await store().send({ fromProject: from as ProjectId, title: 'batch() drops nested effects', body: 'Found while testing.' });
        const second = await store().send({ fromProject: from as ProjectId, title: 'Rename the CLI', body: 'Please.' });

        const dom = await mountLive(`/projects/${to}/requests`, h);
        await until(() => rowState(dom, first.id) === 'needs-you', 'the held request');
        expect(text(dom.querySelector(`[data-requests-row="${first.id}"] [data-requests-row-note]`))).toBe('· waiting for you to let it in');
        expect(dom.querySelector('[data-requests-note]')).toBeNull();

        // Let it in: the manager triages it next.
        dom.querySelector<HTMLElement>(`[data-requests-row="${first.id}"] button`)!.click();
        await tick();
        button(dom.querySelector('[data-requests-detail]')!, 'Let it in')!.click();
        await until(() => rowState(dom, first.id) === 'triaging', 'the request let in');

        // The manager's triage goes to a person (high priority); the person accepts it as proposed.
        const triage: Triage = { kind: 'bug', priority: 'high', similar: [], proposedItem: { title: 'Fix batch()', doneWhen: ['nested batch test passes'] }, openIssue: false, reply: 'Taking it.', why: '' };
        const manager: Principal = { kind: 'agent', agentId: nova, workspaceId: WS, sessionId: 'sess_nova' as SessionId };
        await store(manager).triage(first.id, triage);
        await until(() => rowState(dom, first.id) === 'needs-you', 'the triage that needs you');
        dom.querySelector<HTMLElement>(`[data-requests-row="${first.id}"] button`)!.click();
        await tick();
        button(dom.querySelector('[data-requests-detail]')!, 'Accept as proposed')!.click();
        await until(() => rowState(dom, first.id) === 'accepted', 'the accepted request');
        const accepted = await store().get(first.id);
        const { plans } = await h.app.as(owner).actor(Plan, planKey(WS, to as ProjectId)).list();
        expect(plans[0]!.phases.flatMap((p) => p.items).find((i) => i.id === accepted.resultItem)?.title).toBe('Fix batch()');
        await until(() => text(button(dom, 'Linked 1')) === 'Linked 1', 'the linked count');

        // Decline the other with a reason.
        dom.querySelector<HTMLElement>(`[data-requests-row="${second.id}"] button`)!.click();
        await tick();
        button(dom.querySelector('[data-requests-detail]')!, 'Decline')!.click();
        await tick();
        const form = dom.querySelector<HTMLFormElement>('[data-requests-text-form="decline"]')!;
        const area = form.querySelector('textarea')!;
        area.value = 'Not ours';
        area.dispatchEvent(new Event('input', { bubbles: true }));
        await tick();
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await until(() => rowState(dom, second.id) === 'declined', 'the declined request');
        expect((await store().get(second.id)).declineReason).toBe('Not ours');
    });

    it('shows a refusal from the store as the note', { timeout: 30_000 }, async () => {
        const nova = await h.agent('Nova', 'Manages');
        const { id: from } = await saveProjectWith(clientDefs(), USER, { name: 'alpha', members: { agentIds: [], coordinator: null }, folders: {}, connectors: [], features: {} });
        const { id: to } = await saveProjectWith(clientDefs(), USER, { name: 'beta', members: { agentIds: [nova], coordinator: nova }, folders: {}, connectors: [], features: {} });
        const store = (p: Principal = owner) => h.app.as(p).actor(Requests, requestsKey(WS, to as ProjectId));
        const r = await store().send({ fromProject: from as ProjectId, title: 'What is the plan?', body: '?' });
        await store().admit(r.id);
        const manager: Principal = { kind: 'agent', agentId: nova, workspaceId: WS, sessionId: 'sess_nova' as SessionId };
        await store(manager).triage(r.id, { kind: 'question', priority: 'high', similar: [], openIssue: false, reply: 'Asking a person.', why: '' });

        const dom = await mountLive(`/projects/${to}/requests`, h);
        await until(() => rowState(dom, r.id) === 'needs-you', 'the request');
        dom.querySelector<HTMLElement>(`[data-requests-row="${r.id}"] button`)!.click();
        await tick();
        button(dom.querySelector('[data-requests-detail]')!, 'Accept as proposed')!.click();
        await until(() => dom.querySelector('[data-requests-note]') !== null, 'the refusal');
        expect(text(dom.querySelector('[data-requests-note]'))).toContain('Could not accept it:');
        expect(rowState(dom, r.id)).toBe('needs-you');
    });
});
