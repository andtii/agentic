/**
 * The Plan graph's mock plans (#756): what the view draws on mock data until the Plan store lands. Local to the graph
 * so it never collides with the list's mock (#754); keyed by project id.
 */
import type { AgentId, Plan, PlanItem, ProjectId } from '@agentic/core';

const item = (id: number, title: string, state: PlanItem['state'], after: readonly number[] = [], agent?: string): PlanItem => ({
    id,
    title,
    state,
    ...(agent ? { assignee: { kind: 'agent', agentId: agent as AgentId } } : {}),
    after,
    touches: [],
    refs: [],
    doneWhen: [],
    activity: []
});

const agentic = 'p_agentic' as ProjectId;

export const MOCK_GRAPH_PLANS: Readonly<Record<string, readonly Plan[]>> = {
    p_agentic: [
        {
            id: 'plan_redesign',
            projectId: agentic,
            title: 'Projects redesign',
            phases: [
                {
                    n: 1,
                    title: 'Contracts',
                    items: [
                        item(41, 'Project record and features contract', 'done', [], 'forge'),
                        item(42, 'Plan types and helpers', 'done', [41], 'forge'),
                        item(43, 'Request and triage contract', 'claimed', [41], 'atlas')
                    ]
                },
                {
                    n: 2,
                    title: 'Pages',
                    items: [
                        item(44, 'Projects scaffold', 'done', [41], 'forge'),
                        item(45, 'Plan list view', 'claimed', [42, 44], 'forge'),
                        item(46, 'Plan board view', 'blocked', [45], 'lint'),
                        item(47, 'Plan graph view', 'ready', [45]),
                        item(48, 'Decide: keep a2a as its own kind?', 'needs-you', [44])
                    ]
                },
                {
                    n: 3,
                    title: 'Ship',
                    items: [
                        item(49, 'e2e over the new routes', 'stuck', [46, 47], 'lint'),
                        item(50, 'Release notes', 'ready', [49])
                    ]
                }
            ]
        },
        {
            id: 'plan_release',
            projectId: agentic,
            title: 'Release 0.4',
            phases: [
                { n: 1, title: 'Prepare', items: [item(60, 'Freeze main', 'ready'), item(61, 'Changelog from PR titles', 'ready', [60])] }
            ]
        }
    ]
};
