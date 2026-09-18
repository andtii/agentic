/**
 * The agent pages over the real wire (#153): the Memory tab on the agent's
 * Memory scope (list, correct, retire, the learning switch as a config
 * version, Delete only where a delete exists), presence and the Sessions tab
 * from the task index while a run waits on an approval, a learning proposal
 * accepted and rejected from the rail, the pickers' catalogue, and the
 * roster's pill and counters.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AgentId, MemoryEntry, MessageId, SessionId, TaskId } from '@agentic/core';
import { isoWeek } from '@agentic/learning';
import { AgentActor, LedgerActor, Memory, TaskActor, Workspace, agentKey, ledgerKey, ledgerMonth, memoryActorKey, taskKey, workspaceKey } from '@agentic/platform';
import { PLATFORM_TOOL_NAMES } from '@agentic/runtimes';
import { agentProfile } from '../../src/mock/agents';
import { MemoryTab, type MemoryTabStore } from '../../src/pages/agent/MemoryTab';
import { USER, WS, mountLive, owner, startLive, until, type LiveHarness } from './live-harness';
import { buttonNamed, mountAt, setText, text, tick } from './helpers';

let h: LiveHarness;
beforeEach(async () => {
    h = await startLive({
        respond: (input) => {
            const said = input.map((p) => (p.type === 'text' ? p.text : '')).join('');
            if (said.startsWith('push')) return [{ tool: { name: 'push', category: 'destructive', input: { cmd: 'git push' }, output: 'ok', permissionKey: 'push:origin' } }, { text: 'pushed' }];
            return [{ text: `echo: ${said}` }];
        }
    });
});
afterEach(async () => {
    await h.stop();
});

const memoryOf = (agentId: string) => h.app.as(owner).actor(Memory, memoryActorKey(WS, `agent:${agentId as AgentId}`));
const agentOf = (agentId: string) => h.app.as(owner).actor(AgentActor, agentKey(WS, agentId as AgentId));
const fact = (textOf: string) => ({ kind: 'fact' as const, text: textOf, tags: [], confidence: 'verified' as const, provenance: { source: 'agent' as const } });

const ready = (dom: ParentNode, id: string) => dom.querySelector(`[data-page="agent"][data-agent="${id}"]:not([aria-busy])`) !== null;
const rows = (dom: ParentNode) => [...dom.querySelectorAll<HTMLElement>('[data-memory-row]')];
const rowOf = (dom: ParentNode, id: string) => dom.querySelector<HTMLElement>(`[data-memory-row][data-memory-id="${id}"]`);
const action = (row: Element, label: string) => [...row.querySelectorAll<HTMLButtonElement>('[data-memory-actions] button')].find((b) => b.getAttribute('aria-label') === label);
const pillOf = (root: ParentNode | null) => root?.querySelector('[data-scope="ag-pill"]')?.getAttribute('data-status') ?? null;

/** A task for `agentId` in a fresh chat, run through the router; `push …` parks it on an approval. */
async function run(agentId: string, objective: string) {
    const { chatId } = await h.app.as(owner).actor(Workspace, workspaceKey(WS)).createChat({});
    const taskId = `t_${objective.replace(/\W+/g, '_')}` as TaskId;
    const task = h.app.as(owner).actor(TaskActor, taskKey(WS, taskId));
    await task.create({ objective, origin: { kind: 'user', chatId, messageId: 'm1' as MessageId }, assignee: agentId as AgentId, context: [], constraints: {} }, { owner: agentId as AgentId });
    await h.app.as(owner).actor(h.Routing, `${USER}:routing:main`).run(taskId);
    return { taskId, task };
}

describe('/agents/:id Memory tab (live)', () => {
    it('lists the scope, persists a correction and a retirement across a remount', async () => {
        const atlas = await h.agent('Atlas', 'Coordinator');
        const kept = await memoryOf(atlas).put(fact('the team deploys on fridays'));
        const gone = await memoryOf(atlas).put({ ...fact('the staging url is old'), kind: 'assumption', confidence: 'assumed' });

        const dom = await mountLive(`/agents/${atlas}?tab=memory`, h);
        await until(() => ready(dom, atlas) && rows(dom).length === 2, 'both memories');
        expect(text(rowOf(dom, kept.id)!.querySelector('[data-memory-text]'))).toBe('the team deploys on fridays');
        expect(text(rowOf(dom, kept.id)!.querySelector('[data-memory-confidence]'))).toBe('VERIFIED');
        expect(text(dom.querySelector('[data-memory-scopes] .mono'))).toBe(`agent:${atlas}`);
        expect(action(rowOf(dom, kept.id)!, 'Correct this memory')).toBeDefined();

        action(rowOf(dom, kept.id)!, 'Correct this memory')!.click();
        await until(() => document.querySelector('textarea[name="correction"]') !== null, 'the correction dialog');
        setText(document.querySelector<HTMLTextAreaElement>('textarea[name="correction"]')!, 'the team deploys on thursdays');
        buttonNamed(document.body, 'Save correction').click();
        await until(() => text(rowOf(dom, kept.id)?.querySelector('[data-memory-text]')) === 'the team deploys on thursdays', 'the corrected text from the actor');
        expect(await memoryOf(atlas).get(kept.id)).toMatchObject({ text: 'the team deploys on thursdays', confidence: 'stated', provenance: { source: 'user' } });
        expect(text(rowOf(dom, kept.id)!.querySelector('[data-memory-confidence]'))).toBe('STATED');

        action(rowOf(dom, gone.id)!, 'Retire this memory')!.click();
        await until(() => rowOf(dom, gone.id)?.hasAttribute('data-retired') === true, 'the retired row');
        expect((await memoryOf(atlas).get(gone.id))?.retired).toBe(true);
        expect(text(rowOf(dom, gone.id)!.querySelector('[data-memory-superseded]'))).toBe('retired');

        // another tab: what it reads is what the actor holds
        const again = await mountLive(`/agents/${atlas}?tab=memory`, h);
        await until(() => ready(again, atlas) && rows(again).length === 2, 'both memories again');
        expect(text(rowOf(again, kept.id)!.querySelector('[data-memory-text]'))).toBe('the team deploys on thursdays');
        expect(rowOf(again, gone.id)!.hasAttribute('data-retired')).toBe(true);
        // a write from elsewhere (the agent remembering) reaches the open tab
        await memoryOf(atlas).put(fact('the freeze starts on the 20th'));
        await until(() => rows(dom).length === 3, 'the new memory in the open tab');
    });

    it('the learning switch records a config version', async () => {
        const atlas = await h.agent('Atlas');
        const dom = await mountLive(`/agents/${atlas}?tab=memory`, h);
        await until(() => ready(dom, atlas), 'the agent page');
        const sw = () => dom.querySelector<HTMLInputElement>('[data-learning-head] input[role="switch"]')!;
        expect(sw().checked).toBe(true);
        sw().click();
        await until(async () => (await agentOf(atlas).get()).config.memoryPolicy.autoLearn === 'off', 'learning off on the actor');
        const versions = await agentOf(atlas).listVersions();
        expect(versions.at(-1)).toMatchObject({ version: 2, reason: 'Learning off' });
        expect(sw().checked).toBe(false);
        // a change from elsewhere moves the switch and is not written back
        await agentOf(atlas).update({ memoryPolicy: { shared: [], autoLearn: 'lessons' } }, 'from another tab');
        await until(() => sw().checked, 'the switch to follow the actor');
        await tick();
        expect((await agentOf(atlas).listVersions()).map((v) => v.reason).at(-1)).toBe('from another tab');
    });

    const base: MemoryTabStore = { correct: async () => undefined, retire: async () => undefined, setLearning: async () => undefined };

    it('MEM-05/08: Delete removes the entry through the Memory actor', async () => {
        const atlas = await h.agent('Atlas', 'Coordinator');
        const kept = await memoryOf(atlas).put(fact('the team deploys on fridays'));
        const gone = await memoryOf(atlas).put(fact('the staging url is old'));

        const dom = await mountLive(`/agents/${atlas}?tab=memory`, h);
        await until(() => ready(dom, atlas) && rows(dom).length === 2, 'both memories');
        action(rowOf(dom, gone.id)!, 'Delete this memory')!.click();
        await until(() => [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Delete memory'), 'the delete dialog');
        buttonNamed(document.body, 'Delete memory').click();
        await until(() => rows(dom).length === 1, 'the row to leave');
        expect(rowOf(dom, kept.id)).not.toBeNull();
        expect(await memoryOf(atlas).get(gone.id)).toBeUndefined();
        expect(await memoryOf(atlas).stats()).toMatchObject({ entries: 1 });
    });

    it('draws no Delete for a store that cannot delete (the AC-15 rule)', async () => {
        const profile = agentProfile('a2')!;
        const without = await mountAt('/agents/a2?tab=memory', <MemoryTab profile={profile} store={base} />);
        expect(rows(without).length).toBe(profile.memories.length);
        expect(without.querySelector('[data-memory-actions] button[aria-label="Delete this memory"]')).toBeNull();
        expect(without.querySelector('[data-memory-actions] button[aria-label="Retire this memory"]')).not.toBeNull();
    });

    it('draws Delete for a store that can, and deletes through it', async () => {
        const profile = agentProfile('a2')!;
        const calls: string[] = [];
        const withRemove = await mountAt('/agents/a2?tab=memory', <MemoryTab profile={profile} store={{ ...base, remove: async (e: MemoryEntry) => { calls.push(e.id); } }} />);
        const first = rows(withRemove)[0]!;
        action(first, 'Delete this memory')!.click();
        await until(() => [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Delete memory'), 'the delete dialog');
        buttonNamed(document.body, 'Delete memory').click();
        await tick();
        expect(calls).toEqual([first.getAttribute('data-memory-id')]);
        // the list is the page's read of the actor: the tab itself drops nothing
        expect(rows(withRemove).length).toBe(profile.memories.length);
    });
});

describe('/agents/:id presence, sessions and counters (live)', () => {
    it('follows a run: waiting while it asks, its session in the tabs, idle once it settles', async () => {
        const forge = await h.agent('Forge', 'Builds things');
        await agentOf(forge).update({ tools: [{ name: 'push' }], approvalPolicy: [{ id: 'category:destructive', match: { categories: ['destructive'] }, outcome: 'ask' }] }, 'ask on destructive');

        const dom = await mountLive(`/agents/${forge}?tab=sessions`, h);
        await until(() => ready(dom, forge), 'the agent page');
        expect(pillOf(dom.querySelector('[data-agent-header]'))).toBe('idle');
        expect([...dom.querySelectorAll('[data-scope="ag-empty"]')].some((e) => text(e).includes('No sessions yet'))).toBe(true);

        const { task } = await run(forge, 'push it');
        await until(() => pillOf(dom.querySelector('[data-agent-header]')) === 'waiting', 'the header pill to say waiting');
        const sessionId = (await task.get()).sessionId as SessionId;
        expect(sessionId).toBeTruthy();
        await until(() => dom.querySelector(`[data-agent-sessions] a[href="/sessions/${sessionId}"]`) !== null, 'the run’s session in the Sessions tab');
        const tableRow = dom.querySelector(`[data-agent-sessions] a[href="/sessions/${sessionId}"]`)!.closest('tr')!;
        expect(text(tableRow)).toContain('Forge');
        expect(tableRow.querySelector('[data-scope="ag-env-line"]')?.getAttribute('title')).toBe('platform / anthropic-api / byo-key');
        expect(pillOf(tableRow)).toBe('waiting');

        // the roster says the same, from the same index
        const roster = await mountLive('/agents', h);
        await until(() => pillOf(roster.querySelector(`[data-agent-card="${forge}"]`)) === 'waiting', 'the roster pill');

        const session = h.app.as(owner).actor(h.Session, `${USER}:session:${sessionId}`);
        const open = await session.requests();
        await session.respond(open[0]!.request.requestId, { type: 'permission', outcome: 'allow', scope: 'once' });
        await until(() => pillOf(dom.querySelector('[data-agent-header]')) === 'idle', 'the header pill to go idle');
        expect(pillOf(tableRow.isConnected ? tableRow : dom.querySelector('[data-agent-sessions] tbody tr'))).toBe('completed');
        await until(() => pillOf(roster.querySelector(`[data-agent-card="${forge}"]`)) === 'idle', 'the roster pill to go idle');
    });

    it('the roster and the rail count memories and the week’s corrections for real', async () => {
        const atlas = await h.agent('Atlas');
        const lint = await h.agent('Lint');
        await memoryOf(atlas).put(fact('one'));
        await memoryOf(atlas).put(fact('two'));
        const retired = await memoryOf(atlas).put(fact('three'));
        await memoryOf(atlas).retire(retired.id, 'stale');
        const now = Date.now();
        const ledger = h.app.as(owner).actor(LedgerActor, ledgerKey(WS, ledgerMonth(now)));
        await ledger.recordCorrection({ agentId: atlas as AgentId, week: isoWeek(now), what: 'wrong', at: now });
        await ledger.recordCorrection({ agentId: atlas as AgentId, week: isoWeek(now), what: 'prefer', at: now });

        const roster = await mountLive('/agents', h);
        const stats = (id: string) => [...roster.querySelectorAll(`[data-agent-card="${id}"] [data-agent-card-stats] div`)].map((d) => `${text(d.querySelector('dd'))} ${text(d.querySelector('dt'))}`);
        await until(() => stats(atlas).join('|') === 'v1 config|2 memories|2 corrections / wk', 'Atlas’s counters');
        expect(stats(lint)).toEqual(['v1 config', '0 memories', '0 corrections / wk']);

        const dom = await mountLive(`/agents/${atlas}?tab=memory`, h);
        const counters = () => [...dom.querySelectorAll('[data-learning-counters] div')].map((d) => `${text(d.querySelector('dt'))} ${text(d.querySelector('dd'))}`);
        await until(() => counters().join('|') === 'Corrections this week 2|Repeated mistakes 1', 'the learning counters');

        // live: a correction recorded while the roster is open
        await ledger.recordCorrection({ agentId: atlas as AgentId, week: isoWeek(now), what: 'never', at: now });
        await until(() => stats(atlas)[2] === '3 corrections / wk', 'the new correction on the roster');
    });
});

describe('/agents/:id Config tab (live)', () => {
    const proposeTo = (agentId: string, patch: string) =>
        agentOf(agentId).propose([{ kind: 'instruction', patch, reason: 'Corrected twice.', requiresReview: true }], { kind: 'correction', sessionId: 's_1' as SessionId });
    const proposedItem = (dom: ParentNode) => dom.querySelector<HTMLElement>('[data-versions-list] [data-scope="ag-version"][data-part="root"][data-tone="needs-you"]');
    const versionCount = (dom: ParentNode) => dom.querySelectorAll('[data-versions-list] [data-scope="ag-version"][data-part="root"]').length;

    it('a learning proposal is accepted from the rail as a new version, and the form follows', async () => {
        const atlas = await h.agent('Atlas');
        await proposeTo(atlas, 'Run the tests before you answer.');
        const dom = await mountLive(`/agents/${atlas}?tab=config`, h);
        await until(() => ready(dom, atlas) && proposedItem(dom) !== null, 'the proposed version');
        expect(text(proposedItem(dom)!.querySelector('[data-part="head"]'))).toContain('v2');
        expect(text(proposedItem(dom)!.querySelector('[data-part="reason"]'))).toBe('Corrected twice. Adds: “Run the tests before you answer.”');
        expect(versionCount(dom)).toBe(2);

        buttonNamed(proposedItem(dom)!, 'Review').click();
        await until(() => proposedItem(dom) === null, 'the proposal to leave the rail');
        const after = await agentOf(atlas).get();
        expect(after).toMatchObject({ configVersion: 2, pendingProposals: 0 });
        expect(after.config.instructions).toContain('Run the tests before you answer.');
        await until(() => versionCount(dom) === 2, 'v2 in the rail');
        // the form restarted from the actor's config: a later save cannot undo the accepted patch
        expect(dom.querySelector<HTMLTextAreaElement>('textarea[name="instructions"]')!.value).toBe(after.config.instructions);
        expect(dom.querySelector('[data-save-card]')).toBeNull();
    });

    it('a dismissed proposal is rejected on the actor and no version is recorded', async () => {
        const atlas = await h.agent('Atlas');
        await proposeTo(atlas, 'Always answer in French.');
        const dom = await mountLive(`/agents/${atlas}?tab=config`, h);
        await until(() => ready(dom, atlas) && proposedItem(dom) !== null, 'the proposed version');
        buttonNamed(proposedItem(dom)!, 'Dismiss').click();
        await until(() => proposedItem(dom) === null, 'the proposal to leave the rail');
        expect((await agentOf(atlas).listProposals()).map((p) => p.status)).toEqual(['rejected']);
        expect((await agentOf(atlas).get()).configVersion).toBe(1);
        expect(versionCount(dom)).toBe(1);
    });

    it('the tools picker offers the platform’s tools, not the design track’s names', async () => {
        const atlas = await h.agent('Atlas');
        const dom = await mountLive(`/agents/${atlas}?tab=config`, h);
        await until(() => ready(dom, atlas) && dom.querySelector('form[data-form="agent"]') !== null, 'the form');
        const field = dom.querySelector<HTMLElement>('[data-section="capabilities"]')!;
        const offered = [...field.querySelectorAll('option, [role="option"]')].map((o) => o.getAttribute('value') ?? text(o));
        for (const name of PLATFORM_TOOL_NAMES) expect(offered).toContain(name);
        expect(offered).not.toContain('memory.search');
        expect(offered).not.toContain('task.report');
        expect(offered).not.toContain('sigx-actors');
    });

    it('#169: after a rollback the form edits the rolled-back config, so the next save does not write the old draft back', async () => {
        const atlas = await h.agent('Atlas', 'Coordinator');
        await agentOf(atlas).update({ role: 'Planner' }, 'Planner now');
        const dom = await mountLive(`/agents/${atlas}?tab=config`, h);
        const roleInput = () => dom.querySelector<HTMLInputElement>('input[name="role"]');
        await until(() => ready(dom, atlas) && roleInput()?.value === 'Planner', 'the form on v2');

        buttonNamed(dom, 'Roll back to v1').click();
        await until(async () => (await agentOf(atlas).get()).config.role === 'Coordinator', 'the rollback on the actor');
        await until(() => roleInput()?.value === 'Coordinator', 'the form on the rolled-back config');

        setText(dom.querySelector<HTMLInputElement>('input[name="description"]')!, 'Keeps the plan');
        await tick();
        dom.querySelector('form[data-form="agent"]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await until(async () => (await agentOf(atlas).get()).config.description === 'Keeps the plan', 'the save');
        expect((await agentOf(atlas).get()).config.role).toBe('Coordinator');
    });
});
