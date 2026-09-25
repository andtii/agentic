/**
 * The Requests inbox (#761) on mock data: tabs Incoming / Sent / Linked with their counts, the 360px list with state
 * pills, the detail (origin path, what they sent, the triage card, the reply) and the four actions — Accept as
 * proposed, Edit first (the proposed item in an editable form), Ask for more and Decline.
 */
import { describe, it, expect } from 'vitest';
import type { AgentId, ProjectId, ProjectRequest } from '@agentic/core';
import { MOCK_REQUESTS } from '../../src/mock/projects/requests';
import { PROJECTS } from '../../src/mock/workspace';
import {
    accept, actorName, askForMore, boxCount, decline, draftErrors, draftOf, entriesIn, githubRepoOf, itemMeta, itemOfDraft, kindLine, nextItemNumber,
    requestPill, senderLine, type ActorNames, type RequestEntry
} from '../../src/pages/projects/requests/model';
import { text } from '../pages/helpers';
import { mountRoute, page, texts, tick } from '../pages/mount';

const names: ActorNames = (id) => ({ name: id.slice(0, 1).toUpperCase() + id.slice(1) });
const entries = MOCK_REQUESTS['p_agentic']!;
const batch = entries.find((e) => e.request.id === 'req_7c2a')!;
const agentic = PROJECTS.find((p) => p.id === 'p_agentic')!;

const bare = (state: ProjectRequest['state']): RequestEntry => ({
    box: 'incoming',
    fromProjectName: 'x',
    toProjectName: 'agentic',
    request: {
        id: 'req_x', fromProject: 'p_x' as ProjectId, toProject: 'p_agentic' as ProjectId, sender: { kind: 'agent', agentId: 'forge' as AgentId },
        title: 't', body: 'b', refs: [], state, createdAt: 1, updatedAt: 1
    }
});

describe('the Requests model (#761)', () => {
    it('pills every state as the handoff table says', () => {
        expect(requestPill('needs-you', 'Nova')).toEqual({ label: 'NEEDS YOU', tone: 'needs-you', hollow: false });
        expect(requestPill('triaging', 'Nova')).toEqual({ label: 'NOVA TRIAGING', tone: 'working', hollow: false });
        expect(requestPill('asked-for-more', 'Nova')).toEqual({ label: 'ASKED FOR MORE', tone: 'dim', hollow: true });
        expect(requestPill('accepted', 'Nova')).toEqual({ label: 'ACCEPTED', tone: 'muted', hollow: false });
        expect(requestPill('declined', 'Nova')).toEqual({ label: 'DECLINED', tone: 'dim', hollow: true });
    });

    it('counts open incoming requests, and every sent or linked one; lists what needs you first, then newest', () => {
        expect([boxCount(entries, 'incoming'), boxCount(entries, 'sent'), boxCount(entries, 'linked')]).toEqual([3, 0, 4]);
        expect(entriesIn(entries, 'incoming').map((e) => e.request.state)).toEqual(['needs-you', 'triaging', 'asked-for-more', 'accepted']);
    });

    it('writes the triage lines', () => {
        const t = batch.request.triage!;
        expect(kindLine(t, 'core')).toBe('Bug in core');
        expect(kindLine(t)).toBe('Bug');
        expect(senderLine(batch, names, 'Andii')).toBe('Forge, sent by you');
        expect(itemMeta(t.proposedItem!, names, 'Andii')).toBe('Forge, top of queue · done when repro passes and bench holds');
        expect(githubRepoOf(agentic)).toBe('andtii/agentic');
        expect(githubRepoOf({ features: {} })).toBeUndefined();
        expect(githubRepoOf({ features: { git: { origin: 'git@github.com:andtii/signalx.git' } } })).toBe('andtii/signalx');
        expect(actorName({ kind: 'user', userId: 'kim' }, names, 'Andii')).toBe('kim');
    });

    it('turns an edited draft back into a proposed item, and refuses an empty title', () => {
        const d = draftOf(batch.request.triage!);
        expect(d).toEqual({ title: 'batch() keeps pending updates when an effect throws', phase: '1', assignee: 'forge', doneWhen: 'repro passes\nbench holds', first: true, openIssue: true });
        expect(draftErrors({ ...d, title: '  ' })).toEqual({ title: 'The item needs a title.' });
        expect(itemOfDraft({ ...d, phase: '', assignee: 'lint', doneWhen: 'a\n\n b ', first: false })).toEqual({ title: d.title, assignee: { kind: 'agent', agentId: 'lint' }, doneWhen: ['a', 'b'] });
    });

    it('resolves only a request that needs you', () => {
        const n = nextItemNumber(entries, 13);
        expect(n).toBe(17);
        const done = accept(batch, n, 99);
        expect(done.request).toMatchObject({ state: 'accepted', resultItem: 17, updatedAt: 99 });
        expect(accept(done, 18, 100)).toBe(done);
        expect(askForMore(batch, 'Which version?', 'Atlas', 5)).toMatchObject({ request: { state: 'asked-for-more' }, note: 'Atlas asked: Which version?' });
        expect(askForMore(batch, '  ', 'Atlas', 5)).toBe(batch);
        expect(decline(batch, 'Not ours', 5).request).toMatchObject({ state: 'declined', declineReason: 'Not ours' });
        expect(decline(bare('triaging'), 'x', 5).request.state).toBe('triaging');
    });
});

const detail = (dom: ParentNode) => dom.querySelector<HTMLElement>('[data-requests-detail]')!;
const button = (root: ParentNode, label: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => text(b) === label)!;
const click = async (el: HTMLElement): Promise<void> => {
    el.click();
    await tick();
};
const type = async (el: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> => {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
};
const submit = async (form: HTMLFormElement): Promise<void> => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await tick();
};

describe('the Requests page (#761)', () => {
    it('renders the board at /projects/p_agentic/requests: tabs, list, and the request that needs you', async () => {
        const dom = await mountRoute('/projects/p_agentic/requests');
        const el = page(dom, 'project-requests')!;
        expect(el.querySelector('[data-stub]')).toBeNull();
        expect(text(el.querySelector('[data-requests-lede]'))).toBe('What other projects ask agentic for. Atlas, the project manager, triages each one and asks you when it changes the plan.');
        expect(texts([...el.querySelectorAll('[data-requests-head] button')])).toEqual(['Incoming 3', 'Sent 0', 'Linked 4']);
        const rows = [...el.querySelectorAll<HTMLElement>('[data-requests-row]')];
        expect(rows.map((r) => r.getAttribute('data-requests-row'))).toEqual(['req_7c2a', 'req_5e19', 'req_3b07', 'req_1a44']);
        expect(texts(rows.map((r) => r.querySelector('[data-status]')!))).toEqual(['NEEDS YOU', 'ATLAS TRIAGING', 'ASKED FOR MORE', 'ACCEPTED']);
        expect(text(rows[3]!.querySelector('[data-requests-row-note]'))).toBe('→ agentic#12');
        expect(text(rows[2]!.querySelector('[data-requests-row-note]'))).toBe('· Atlas asked which page');

        // The first row is open until another is picked.
        expect(rows[0]!.hasAttribute('data-selected')).toBe(true);
        const d = detail(el);
        expect(d.getAttribute('data-requests-detail')).toBe('req_7c2a');
        expect(text(d.querySelector('[data-requests-title]'))).toBe('batch() drops updates when an effect throws');
        expect(texts([...d.querySelectorAll('[data-requests-path] [data-requests-chip]')])).toEqual(['signalx', 'Usage rings on the member card']);
        expect(text(d.querySelector('[data-requests-sender]'))).toContain('Forge, sent by you');
        expect(texts([...d.querySelectorAll('[data-requests-refs] [data-requests-ref]')])).toEqual(['src/usage.test.ts:12-40', 'stack-trace.txt', 'signalx#16']);
        const triage = d.querySelector('[data-requests-triage]')!;
        expect(text(triage.querySelector('[data-requests-why]'))).toBe('why you: high priority moves this week’s plan');
        expect(text(triage.querySelector('[data-requests-kv="kind"] dd'))).toBe('Bug in core');
        expect(text(triage.querySelector('[data-requests-kv="priority"] dd'))).toBe('High blocks a release in another project');
        expect(text(triage.querySelector('[data-requests-kv="similar"] dd'))).toContain('closed, nested batch; different cause');
        expect(text(triage.querySelector('[data-requests-item-title]'))).toBe('batch() keeps pending updates when an effect throws');
        expect(text(triage.querySelector('[data-requests-item-meta]'))).toContain('Core fixes');
        expect(text(triage.querySelector('[data-requests-kv="also"]'))).toContain('open GitHub issue in andtii/agentic');
        expect(text(d.querySelector('[data-requests-reply-head]'))).toBe('Reply Atlas will post in signalx');
        expect(texts([...d.querySelectorAll('[data-requests-actions] button')])).toEqual(['Accept as proposed', 'Edit first', 'Ask for more', 'Decline']);

        // One the manager is still triaging has no triage card and no actions yet.
        await click(rows[1]!.querySelector('button')!);
        expect(detail(el).getAttribute('data-requests-detail')).toBe('req_5e19');
        expect(text(detail(el).querySelector('[data-requests-triage="pending"]'))).toBe('Atlas is triaging this request; it comes to you if it changes the plan.');
        expect(detail(el).querySelector('[data-requests-actions]')).toBeNull();
    });

    it('Accept as proposed turns the request into the next item', async () => {
        const dom = await mountRoute('/projects/p_agentic/requests');
        await click(dom.querySelector<HTMLElement>('[data-requests-row="req_7c2a"] button')!);
        await click(button(detail(dom), 'Accept as proposed'));
        const row = dom.querySelector('[data-requests-row="req_7c2a"]')!;
        expect(row.getAttribute('data-state')).toBe('accepted');
        expect(text(row.querySelector('[data-requests-row-note]'))).toBe('→ agentic#17');
        expect(text(detail(dom).querySelector('[data-requests-outcome]'))).toBe('Accepted as agentic#17.');
        expect(texts([...dom.querySelectorAll('[data-requests-head] button')])[0]).toBe('Incoming 2');
    });

    it('Edit first opens the proposed item in a form; saving accepts it with the edits', async () => {
        const dom = await mountRoute('/projects/p_agentic/requests');
        await click(dom.querySelector<HTMLElement>('[data-requests-row="req_7c2a"] button')!);
        await click(button(detail(dom), 'Edit first'));
        const form = detail(dom).querySelector<HTMLFormElement>('[data-requests-edit]')!;
        expect(form).not.toBeNull();
        const title = form.querySelector<HTMLInputElement>('input[name="item-title"], [name="item-title"] input, input')!;
        expect(title.value).toBe('batch() keeps pending updates when an effect throws');
        expect(form.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('repro passes\nbench holds');
        await type(title, '');
        await submit(form);
        expect(detail(dom).textContent).toContain('The item needs a title.');
        expect(dom.querySelector('[data-requests-row="req_7c2a"]')!.getAttribute('data-state')).toBe('needs-you');
        await type(title, 'batch() flushes pending updates after a throw');
        await submit(form);
        expect(detail(dom).querySelector('[data-requests-edit]')).toBeNull();
        expect(dom.querySelector('[data-requests-row="req_7c2a"]')!.getAttribute('data-state')).toBe('accepted');
        expect(text(detail(dom).querySelector('[data-requests-item-title]'))).toBe('batch() flushes pending updates after a throw');
    });

    it('Ask for more asks for the question, Cancel keeps the request as it was', async () => {
        const dom = await mountRoute('/projects/p_agentic/requests');
        await click(dom.querySelector<HTMLElement>('[data-requests-row="req_7c2a"] button')!);
        await click(button(detail(dom), 'Ask for more'));
        let form = detail(dom).querySelector<HTMLFormElement>('[data-requests-text-form="ask"]')!;
        await click(button(form, 'Cancel'));
        expect(detail(dom).querySelector('[data-requests-text-form]')).toBeNull();
        await click(button(detail(dom), 'Ask for more'));
        form = detail(dom).querySelector<HTMLFormElement>('[data-requests-text-form="ask"]')!;
        await type(form.querySelector('textarea')!, 'Which signalx version?');
        await submit(form);
        const row = dom.querySelector('[data-requests-row="req_7c2a"]')!;
        expect(text(row.querySelector('[data-status]'))).toBe('ASKED FOR MORE');
        expect(text(row.querySelector('[data-requests-row-note]'))).toBe('· Atlas asked: Which signalx version?');
    });

    it('Decline needs a reason, then declines', async () => {
        const dom = await mountRoute('/projects/p_agentic/requests');
        await click(dom.querySelector<HTMLElement>('[data-requests-row="req_7c2a"] button')!);
        await click(button(detail(dom), 'Decline'));
        const form = detail(dom).querySelector<HTMLFormElement>('[data-requests-text-form="decline"]')!;
        await submit(form);
        expect(detail(dom).textContent).toContain('Give a reason.');
        await type(form.querySelector('textarea')!, 'Fixed upstream already');
        await submit(form);
        expect(dom.querySelector('[data-requests-row="req_7c2a"]')!.getAttribute('data-state')).toBe('declined');
        expect(text(detail(dom).querySelector('[data-requests-outcome]'))).toBe('Declined: Fixed upstream already');
    });

    it('Sent is empty and Linked lists the linked items', async () => {
        const dom = await mountRoute('/projects/p_agentic/requests');
        await click(button(dom, 'Sent 0'));
        expect(text(dom.querySelector('[data-requests-list] [data-requests-empty]'))).toBe('Nothing sent from here yet. Agents send one with projects_request.');
        expect(dom.querySelector('[data-requests-detail]')).toBeNull();
        await click(button(dom, 'Linked 4'));
        expect(dom.querySelectorAll('[data-requests-row]')).toHaveLength(4);
        expect(detail(dom).querySelector('[data-requests-triage]')).toBeNull();
    });
});
