/**
 * `/history` over the real wire (#146, OPS-03): a scripted scenario — an
 * agent configured, a task run through the router whose destructive call
 * asks for approval, answered from the inbox — lands each audit kind once
 * on the page, newest first and grouped by day; the kind chips, the agent
 * select and the time window filter through the actor's query; the cursor
 * pages older events in; a new event reaches the open page live.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { MachineId, MessageId, TaskId } from '@agentic/core';
import { AgentActor, AuditActor, TaskActor, Workspace, agentKey, auditKey, taskKey, workspaceKey, type AuditEventInput } from '@agentic/platform';
import { USER, WS, mountLive, owner, startLive, until, type LiveHarness } from './live-harness';
import { buttonNamed, text } from './helpers';
import { HISTORY_PAGE } from '../../src/pages/history/live';

let h: LiveHarness;
beforeEach(async () => {
    h = await startLive({
        respond: (input) => {
            const t = input.map((p) => (p.type === 'text' ? p.text : '')).join('');
            if (t.startsWith('push')) return [{ tool: { name: 'push', category: 'destructive', input: { cmd: 'git push' }, output: 'ok', permissionKey: 'push:origin' } }, { text: 'pushed' }];
            return [{ text: `echo: ${t}` }];
        }
    });
});
afterEach(async () => {
    await h.stop();
});

const audit = () => h.app.as(owner).actor(AuditActor, auditKey(WS));
const rows = (dom: ParentNode) => [...dom.querySelectorAll<HTMLElement>('[data-history-row]')];
const kinds = (dom: ParentNode) => rows(dom).map((r) => r.getAttribute('data-kind'));
const chip = (dom: ParentNode, label: string) => [...dom.querySelectorAll<HTMLButtonElement>('[data-filter-chip]')].find((b) => b.textContent!.trim() === label)!;

/** Forge asking on destructive calls, a task through the router, the approval answered: the scripted scenario. */
async function scenario() {
    const forge = await h.agent('Forge', 'Builds things');
    await h.app.as(owner).actor(AgentActor, agentKey(WS, forge)).update({ tools: [{ name: 'push' }], approvalPolicy: [{ id: 'category:destructive', match: { categories: ['destructive'] }, outcome: 'ask' }] }, 'ask on destructive');
    const { chatId } = await h.app.as(owner).actor(Workspace, workspaceKey(WS)).createChat({});
    const taskId = 't_push' as TaskId;
    const task = h.app.as(owner).actor(TaskActor, taskKey(WS, taskId));
    await task.create({ objective: 'push it', origin: { kind: 'user', chatId, messageId: 'm1' as MessageId }, assignee: forge, context: [], constraints: {} }, { owner: forge });
    await h.app.as(owner).actor(h.Routing, `${USER}:routing:main`).run(taskId);
    await until(async () => (await task.get()).status === 'waiting', 'the approval to park the task');
    const sessionId = (await task.get()).sessionId!;
    const session = h.app.as(owner).actor(h.Session, `${USER}:session:${sessionId}`);
    const [open] = await session.requests({ openOnly: true });
    const reply = await session.respond(open!.request.requestId, { type: 'permission', outcome: 'allow', scope: 'once' });
    expect(reply.kind).toBe('ack');
    await until(async () => (await task.get()).status === 'completed', 'the task to complete');
    return { forge, taskId, sessionId };
}

describe('/history (live)', () => {
    it('shows each audit kind of the scenario once, newest first, with actor and ref; the filters and the cursor work', { timeout: 20_000 }, async () => {
        const { forge, taskId, sessionId } = await scenario();
        const dom = await mountLive('/history', h);
        await until(() => rows(dom).length >= 7, 'the scenario on the page');
        const seqs = rows(dom).map((r) => Number(r.getAttribute('data-seq')));
        expect([...seqs].sort((a, b) => b - a)).toEqual(seqs);
        const counts = new Map<string, number>();
        for (const k of kinds(dom)) counts.set(k!, (counts.get(k!) ?? 0) + 1);
        // Two config versions (create, the ask rule), one environment choice, one approval asked and one resolved, the transitions.
        expect(counts.get('config.versioned')).toBe(2);
        expect(counts.get('environment.chosen')).toBe(1);
        expect(counts.get('approval.requested')).toBe(1);
        expect(counts.get('approval.resolved')).toBe(1);
        expect(counts.get('task.transition')).toBe(4);
        expect(dom.querySelectorAll('[data-day-row]').length).toBe(1);

        const requested = rows(dom).find((r) => r.getAttribute('data-kind') === 'approval.requested')!;
        expect(text(requested.querySelector('[data-agent-cell] > span:last-child'))).toBe('Forge');
        expect(requested.querySelector('a.ag-ref')!.getAttribute('href')).toBe(`/tasks/${taskId}`);
        expect(text(requested.querySelector('[data-scope="ag-pill"]'))).toBe('approval requested');
        const resolved = rows(dom).find((r) => r.getAttribute('data-kind') === 'approval.resolved')!;
        expect(text(resolved.querySelector('[data-agent-cell] > span:last-child'))).toBe('You');
        const config = rows(dom).find((r) => r.getAttribute('data-kind') === 'config.versioned')!;
        expect(config.querySelector('a.ag-ref')!.getAttribute('href')).toBe(`/agents/${forge}`);
        expect(text(config.querySelector('[data-agent-cell] > span:last-child'))).toBe('You');
        expect(rows(dom).some((r) => r.querySelector('a.ag-ref')?.getAttribute('href') === `/sessions/${sessionId}`) || rows(dom).some((r) => r.querySelector('a.ag-ref')?.getAttribute('href') === `/tasks/${taskId}`)).toBe(true);

        // Kind chips are the actor's `kinds` filter.
        chip(dom, 'Approvals').click();
        await until(() => rows(dom).length === 2, 'the approvals only');
        expect(new Set(kinds(dom))).toEqual(new Set(['approval.requested', 'approval.resolved']));
        chip(dom, 'Delegations').click();
        await until(() => rows(dom).length === 0 && dom.querySelector('[data-history-empty]') !== null, 'no delegations');
        chip(dom, 'All').click();
        await until(() => rows(dom).length >= 7, 'everything again');

        // The agent select is `agentId`: the approval and the transitions concern Forge; the config versions do too.
        const select = dom.querySelector<HTMLSelectElement>('[data-history-agent] select')!;
        expect([...select.options].map((o) => o.textContent)).toEqual(['Every actor', 'Forge']);
        select.value = forge;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await until(() => rows(dom).every((r) => r.getAttribute('data-kind') !== 'machine.paired') && rows(dom).length >= 7, 'the agent filter');
        select.value = '';
        select.dispatchEvent(new Event('change', { bubbles: true }));

        // The time window is `since`: an event recorded a month ago falls out of "Last 24 h".
        const old: AuditEventInput = { key: 'old-1', kind: 'machine.paired', at: Date.now() - 30 * 24 * 60 * 60_000, by: `user:${USER}`, summary: 'paired an old machine', data: { machineId: 'm_old' as MachineId, name: 'old-box' } };
        expect(await audit().record(old)).toBe(true);
        await until(() => kinds(dom).includes('machine.paired'), 'the old event to arrive live');
        expect(dom.querySelectorAll('[data-day-row]').length).toBe(2);
        chip(dom, 'Last 24 h').click();
        await until(() => rows(dom).length >= 7 && !kinds(dom).includes('machine.paired'), 'the window to drop the old event');
        chip(dom, 'Any time').click();
        await until(() => kinds(dom).includes('machine.paired'), 'the old event back');

        // The cursor: past one page, "Load older" fetches the next page by `seq` and the rows merge once.
        const before = rows(dom).length;
        for (let i = 0; i < HISTORY_PAGE; i++) await audit().record({ key: `bulk-${i}`, kind: 'plugin.enabled', at: Date.now() + i, by: `user:${USER}`, summary: `enabled plugin ${i}`, data: { pluginId: `p${i}` } });
        await until(() => rows(dom).length === HISTORY_PAGE && dom.querySelector('[data-history-more]') !== null, 'the first page and the Load-older control');
        buttonNamed(dom, 'Load older').click();
        await until(() => rows(dom).length === HISTORY_PAGE + before, 'the second page');
        expect(dom.querySelector('[data-history-more]')).toBeNull();
        expect(new Set(rows(dom).map((r) => r.getAttribute('data-history-row'))).size).toBe(HISTORY_PAGE + before);
        // Newest first by time: the month-old event closes the list under its own day, whatever its `seq`.
        const all = rows(dom);
        expect(all[all.length - 1]!.getAttribute('data-kind')).toBe('machine.paired');
        const recent = all.slice(0, -1).map((r) => Number(r.getAttribute('data-seq')));
        expect([...recent].sort((a, b) => b - a)).toEqual(recent);
    });
});
