/**
 * The work item page on live data (#790): `detailsOf` joins the Work view's derived items (#738) with their task,
 * chat, session and plan item; on the live wire a task asked a question in a project chat renders its page — the
 * stepper at the question, you own the next step, task, chat and session linked — and an unknown id is not found.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WORK_STAGES_FALLBACK, type AgentId, type ChatId, type MessageId, type Plan, type PlanItem, type ProjectId, type SessionId, type TaskId, type WorkItem } from '@agentic/core';
import { TaskActor, taskKey } from '@agentic/platform';
import { clientDefs } from '../../src/actors/client';
import { createChatWith } from '../../src/pages/chat/LiveChats';
import { projectHead } from '../../src/pages/projects/head';
import { saveProjectWith } from '../../src/pages/projects/live';
import { detailsOf, planOf } from '../../src/pages/projects/work/item/live';
import { findWorkItem } from '../../src/pages/projects/work/item/model';
import { USER, WS, mountLive, owner, startLive, texts, until, type LiveHarness } from '../pages/live-harness';

const forge = 'forge' as AgentId;
const workItem = (id: string, more: Partial<WorkItem> = {}): WorkItem => ({
    id, title: id, stages: WORK_STAGES_FALLBACK, stage: 1, stageState: 'working', owner: { kind: 'agent', agentId: forge }, nextStep: 'Working', group: 'agents', updatedAt: 1, ...more
});
const planItem = (id: number): PlanItem => ({ id, title: `Item ${id}`, state: 'claimed', after: [], touches: [], refs: [], doneWhen: [{ text: 'It works', checked: true }], activity: [] });
const plan: Plan = { id: 'pl1', projectId: 'p1' as ProjectId, title: 'Mobile pass', phases: [{ n: 1, title: 'Shell', items: [planItem(11)] }, { n: 2, title: 'Drawer', items: [planItem(12)] }] };

describe('detailsOf (#790)', () => {
    it('joins a task item with its row, chat and session; skips pull requests; finds the plan and phase of a plan item', () => {
        const rows = [{ id: 't1' as TaskId, objective: 'Update the notes', status: 'waiting' as const, assignee: forge, chatId: 'c1' as ChatId, sessionId: 's1' as SessionId }];
        const items = [
            workItem('task:t1', { taskId: 't1' as TaskId, itemRef: '#12' }),
            workItem('pr:5', { pull: 5, taskId: 't1' as TaskId }),
            workItem('item:11', { itemRef: '#11' }),
            workItem('task:t9', { taskId: 't9' as TaskId })
        ];
        const details = detailsOf(items, rows, [{ id: 'c1', title: 'Release checklist' }], [plan]);
        expect(details.map((d) => d.item.id)).toEqual(['task:t1', 'item:11', 'task:t9']);
        expect(details[0]).toMatchObject({
            task: { id: 't1', ref: 't1', objective: 'Update the notes', status: 'waiting', agentId: 'forge' },
            chat: { id: 'c1', title: 'Release checklist' },
            sessionId: 's1',
            plan: { title: 'Mobile pass', phase: 'Phase 2 · Drawer', item: { id: 12 } }
        });
        expect(details[1]!.plan?.phase).toBe('Phase 1 · Shell');
        expect(details[1]!.task).toBeUndefined();
        // A task the index does not hold (yet): the item alone.
        expect(details[2]).toEqual({ item: items[3] });
        // The page finds a live item by its task id, as the Work view links it.
        expect(findWorkItem(details, 't1')?.item.id).toBe('task:t1');
        expect(planOf([plan], 99)).toBeUndefined();
    });
});

let h: LiveHarness;
beforeEach(async () => {
    h = await startLive({
        respond: (input) => {
            const t = input.map((p) => (p.type === 'text' ? p.text : '')).join('');
            if (t.startsWith('ask')) return [{ request: { kind: 'input', message: 'Which branch?' } }, { text: 'thanks' }];
            return [{ text: `echo: ${t}` }];
        }
    });
});
afterEach(async () => {
    projectHead.value = null;
    await h.stop();
});

describe('the work item page on live data (#790)', () => {
    it('renders a task in a project chat: stepper, you answer next, task, chat and session linked; an unknown id is not found', { timeout: 20_000 }, async () => {
        const agentId = await h.agent('Forge', 'Builds things');
        const defs = clientDefs();
        const { id: projectId } = await saveProjectWith(defs, USER, { name: 'agentic', members: { agentIds: [agentId], coordinator: agentId }, folders: {}, connectors: [], features: {} });
        const chatId = await createChatWith(defs, USER, [agentId], agentId, projectId);
        const taskId = 't_ask_scope' as TaskId;
        const task = h.app.as(owner).actor(TaskActor, taskKey(WS, taskId));
        await task.create({ objective: 'ask about the scope', origin: { kind: 'user', chatId: chatId as ChatId, messageId: 'm1' as MessageId }, assignee: agentId, context: [], constraints: {} }, { owner: agentId });
        await h.app.as(owner).actor(h.Routing, `${USER}:routing:main`).run(taskId);
        await until(async () => (await task.get()).status === 'waiting', 'the task to wait for input');
        const sessionId = (await task.get()).sessionId;

        const dom = await mountLive(`/projects/${projectId}/work/${taskId}`, h);
        const el = () => dom.querySelector<HTMLElement>('[data-page="project-work-item"]');
        await until(() => el()?.querySelector('[data-work-item-head]') !== null && el()?.querySelector('[data-link="session"] a') !== null, 'the live item with its session', 10_000);
        const page = el()!;
        expect(page.querySelector('[data-work-item-title]')?.textContent).toBe('ask about the scope');
        expect(texts([...page.querySelectorAll('[data-work-item-steps] > li')])).toEqual(['Ready', 'Do', 'Review', 'Done']);
        expect(page.querySelector('[aria-current="step"]')?.textContent).toBe('Do');
        expect(page.querySelector('[data-owner="you"]')).not.toBeNull();
        expect(page.querySelector('[data-next-step]')?.textContent).toBe('Answer the agent’s question');
        expect(page.querySelector('[data-link="task"] a')?.getAttribute('href')).toBe(`/tasks/${taskId}`);
        expect(page.querySelector('[data-link="chat"] a')?.getAttribute('href')).toBe(`/projects/${projectId}/chats/${chatId}`); // inside the project (#929)
        expect(page.querySelector('[data-link="chat"] a')?.textContent).toBe('Forge'); // an untitled chat is named for its member
        expect(page.querySelector('[data-link="session"] a')?.getAttribute('href')).toBe(`/sessions/${sessionId}`);

        const missing = await mountLive(`/projects/${projectId}/work/t_nope`, h);
        await until(() => (missing.textContent ?? '').includes('No work item with that id'), 'the not-found state', 10_000);
        expect(missing.querySelector('[data-work-item-head]')).toBeNull();
    });
});
