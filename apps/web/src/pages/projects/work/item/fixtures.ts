/**
 * Mock work items for the work item page (#739): a plain task and a plan-backed item, over the sample workspace's
 * tasks and chats. Only this page imports it; the Work view's list has its own (`mock/projects/work.ts`, #738).
 */
import { WORK_STAGES_FALLBACK, type AgentId, type TaskId } from '@agentic/core';
import { MOCK_NOW, chatSummary, taskRow } from '../../../../mock/workspace';
import type { WorkItemDetail } from './model';

const minutesAgo = (m: number): number => MOCK_NOW - m * 60_000;

/** The detail for a sample task: its ref, objective, agent, chat and session as the workspace mock has them. */
function linked(taskId: string): Pick<WorkItemDetail, 'task' | 'chat' | 'sessionId'> {
    const t = taskRow(taskId);
    if (!t) throw new Error(`mock: no task ${taskId}`);
    const chat = t.chatId ? chatSummary(t.chatId) : undefined;
    return {
        task: { id: t.id, ref: t.ref, objective: t.objective, status: t.status, agentId: t.agentId },
        ...(chat ? { chat: { id: chat.id, title: chat.title } } : {}),
        ...(t.sessionId ? { sessionId: t.sessionId } : {})
    };
}

const forge = 'forge' as AgentId;

/** Work items with no pull request, by project id. */
export const MOCK_WORK_ITEMS: Readonly<Record<string, readonly WorkItemDetail[]>> = {
    p_agentic: [
        {
            // A plain task: no plan behind it, the fallback stages.
            item: {
                id: 'task:t_52a1', title: 'Update the release notes for 0.2', taskId: 't7' as TaskId,
                stages: WORK_STAGES_FALLBACK, stage: 1, stageState: 'needs-you', owner: { kind: 'you' },
                nextStep: 'Resume Forge’s interrupted turn', group: 'your-move', updatedAt: minutesAgo(35)
            },
            ...linked('t7')
        },
        {
            // A plan item carried out by a task.
            item: {
                id: 'item:12', title: 'Make the drawer collapse below 768 px', taskId: 't1-1' as TaskId, itemRef: '#12',
                stages: WORK_STAGES_FALLBACK, stage: 1, stageState: 'working', owner: { kind: 'agent', agentId: forge },
                nextStep: 'Collapsing the drawer · waiting on the git push approval', group: 'agents', updatedAt: minutesAgo(14)
            },
            ...linked('t1-1'),
            plan: {
                title: 'Mobile pass',
                phase: 'Phase 2 · Shell',
                item: {
                    id: 12, title: 'Make the drawer collapse below 768 px', state: 'claimed',
                    assignee: { kind: 'agent', agentId: forge }, queueIndex: 0, assignedBy: { kind: 'agent', agentId: 'atlas' as AgentId },
                    claim: { agentId: forge, leaseUntil: minutesAgo(-16), taskId: 't1-1' as TaskId },
                    after: [11], touches: ['packages/ui/src/shell/shell.css'],
                    refs: [{ kind: 'item', n: 11 }, { kind: 'file', path: 'packages/ui/src/shell/shell.css', from: 38, to: 41 }, { kind: 'pr', n: 603 }],
                    doneWhen: [
                        { text: 'The drawer collapses under 768 px', checked: true },
                        { text: 'Focus stays trapped in the open drawer', checked: false },
                        { text: 'Lint approves the change', checked: false }
                    ],
                    activity: [
                        { at: minutesAgo(40), actor: { kind: 'agent', agentId: 'atlas' as AgentId }, text: 'assigned #12 to Forge' },
                        { at: minutesAgo(14), actor: { kind: 'agent', agentId: forge }, text: 'claimed #12' }
                    ]
                }
            }
        }
    ],
    p_docs: [
        {
            item: {
                id: 'task:t_77b1', title: 'Summarise which A2A clients exist today', taskId: 't2' as TaskId,
                stages: WORK_STAGES_FALLBACK, stage: 1, stageState: 'needs-you', owner: { kind: 'you' },
                nextStep: 'Answer Scout’s question on scope', group: 'your-move', updatedAt: minutesAgo(21)
            },
            ...linked('t2')
        }
    ]
};
