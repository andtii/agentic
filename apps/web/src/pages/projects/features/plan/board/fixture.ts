/**
 * The Plan board's mock plan (#755): the PlanBoard artboard's "Plugin manifests v2" on the mock `agentic` project —
 * kept with the board so it never collides with the List's mock (#754). Leases count from `now`.
 */
import type { AgentId, PlanActor, PlanItem, TaskId } from '@agentic/core';

export interface BoardPlan {
    readonly title: string;
    readonly items: readonly PlanItem[];
}

const agent = (id: string): PlanActor => ({ kind: 'agent', agentId: id as AgentId });
const YOU: PlanActor = { kind: 'user', userId: 'me' };

const item = (id: number, title: string, over: Partial<PlanItem> = {}): PlanItem => ({ id, title, state: 'ready', after: [], touches: [], refs: [], doneWhen: [], activity: [], ...over });

export function boardFixture(projectId: string, now: number): BoardPlan | null {
    if (projectId !== 'p_agentic') return null;
    const claimed = (who: string, mins: number, taskId: string): Partial<PlanItem> => ({
        state: 'claimed',
        assignee: agent(who),
        assignedBy: agent('atlas'),
        claim: { agentId: who as AgentId, leaseUntil: now + mins * 60_000, taskId: taskId as TaskId }
    });
    const queued = (who: PlanActor, n: number): Partial<PlanItem> => ({ assignee: who, assignedBy: agent('atlas'), queueIndex: n });
    const done = [1, 2, 3, 4, 5, 6, 7].map((n) => item(n, `Done step ${n}`, { state: 'done' }));
    return {
        title: 'Plugin manifests v2',
        items: [
            ...done,
            item(9, 'Move KIND_ORDER into the manifest registry', { ...claimed('forge', 16, 't_93d1'), touches: ['packages/core/src/plugin-config.ts'] }),
            item(10, 'Plugins page reads groups from the registry', { ...claimed('lint', 22, 't_93d4'), touches: ['packages/core/src/plugin-config.ts', 'apps/web/src/pages/plugins/'] }),
            item(11, 'Drop the hard-coded SINGLE_SLOT_KINDS', { ...queued(agent('forge'), 0), after: [9] }),
            item(12, 'Decide: keep a2a as its own kind?', { state: 'needs-you', ...queued(YOU, 0), options: [{ label: 'Keep a2a' }, { label: 'Fold into runtime' }] }),
            item(13, 'Migration for stored manifests', { ...queued(agent('scout'), 0), after: [9] }),
            item(14, 'Plugin detail shows declared slots', queued(agent('forge'), 1)),
            item(15, 'Update architecture.md §7', { queueIndex: 0, after: [10, 11] }),
            item(16, 'Bump SignalX once batch() is fixed', { state: 'blocked', ...queued(agent('forge'), 2), refs: [{ kind: 'project-item', project: 'signalx', n: 14 }] }),
            item(17, 'Changelog entry for manifests v2', { queueIndex: 1 }),
            item(18, 'Review the migration for stored manifests', { ...queued(agent('lint'), 0), after: [13] })
        ]
    };
}
