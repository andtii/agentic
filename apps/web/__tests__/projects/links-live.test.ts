/** `/projects/links` and the index strip on live data (#881): `workspaceLinks` over each project's `linkItems`, mapped onto the page's views. */
import type { AgentId, PlanItem, PlanItemState, ProjectId, ProjectRecord } from '@agentic/core';
import type { LinkItemInput, LinkProjectInfo } from '@agentic/platform';
import { linkProjectOf, linksViewOf, liveLinksData, openLinksOf, readLinkGraphs, type LinkAgentNames } from '../../src/pages/projects/links/live';
import { itemsOf, linkCount } from '../../src/pages/projects/links/model';

const A = 'p_agentic' as ProjectId;
const S = 'p_signalx' as ProjectId;
const Z = 'p_zero' as ProjectId;
const PROJECTS: LinkProjectInfo[] = [
    { id: A, name: 'agentic', manager: 'agent_atlas' as AgentId },
    { id: S, name: 'signalx', manager: null },
    { id: Z, name: 'zero', manager: null }
];

const item = (id: number, title: string, state: PlanItemState, over: Partial<PlanItem> = {}): PlanItem => ({ id, title, state, after: [], touches: [], refs: [], doneWhen: [], activity: [], ...over });
const input = (it: PlanItem, afterRefs?: { projectId: ProjectId; n: number }[]): LinkItemInput => ({ item: it, ...(afterRefs ? { afterRefs } : {}), planId: 'p1', planTitle: 'agentic 0.5' });

const ITEMS: Record<string, LinkItemInput[]> = {
    [A]: [
        input(item(16, 'Bump SignalX', 'ready'), [{ projectId: S, n: 14 }]),
        input(item(20, 'Release: tag and publish', 'blocked', { after: [16], assignee: { kind: 'user', userId: 'u1' } })),
        input(item(11, 'Adopt stable ordering', 'done'), [{ projectId: S, n: 9 }])
    ],
    [S]: [input(item(14, 'batch() keeps updates on throw', 'claimed', { claim: { agentId: 'agent_forge' as AgentId, leaseUntil: 1 } })), input(item(9, 'Stable ordering', 'done'))]
};

const names: LinkAgentNames = (id) => ({ name: id === 'agent_forge' ? 'Forge' : id === 'agent_atlas' ? 'Atlas' : id, hue: 2 });

describe('live links (#881)', () => {
    it('reads each project once for both views and leaves out a project whose plan throws', async () => {
        const reads: string[] = [];
        const graphs = await readLinkGraphs(PROJECTS, async (id) => {
            reads.push(id);
            if (id === Z) throw new Error('no plan');
            return ITEMS[id] ?? [];
        });
        expect(reads.sort()).toEqual([A, S, Z].sort());
        expect(graphs.open.counts).toEqual({ open: 1, done: 1 });
        expect(graphs.done.show).toBe('done');
    });

    it('maps the open graph onto lanes, refs, arrows, owners and the milestone', async () => {
        const graphs = await readLinkGraphs(PROJECTS, async (id) => ITEMS[id] ?? []);
        const view = linksViewOf(graphs.open, names);
        expect(view.lanes.map((l) => l.name).sort()).toEqual(['agentic', 'signalx']);
        expect(view.lanes.find((l) => l.projectId === A)?.manager).toEqual({ name: 'Atlas', hue: 2 });
        const items = itemsOf(view);
        expect(items.get('agentic#16')).toMatchObject({ state: 'blocked', after: ['signalx#14'], meta: 'waits on signalx#14' });
        expect(items.get('signalx#14')).toMatchObject({ state: 'claimed', owner: { name: 'Forge', hue: 2 }, after: [] });
        expect(items.get('agentic#20')).toMatchObject({ milestone: true, after: ['agentic#16'], owner: { name: 'You', person: true } });
        expect(linkCount(view)).toBe(2);
        expect(items.has('agentic#11')).toBe(false);
    });

    it('maps the done view, and the strip reads the open count and each chain', async () => {
        const graphs = await readLinkGraphs(PROJECTS, async (id) => ITEMS[id] ?? []);
        const data = liveLinksData(graphs, names);
        expect(itemsOf(data.done).get('agentic#11')).toMatchObject({ state: 'done', after: ['signalx#9'] });
        expect(openLinksOf(graphs.open)).toEqual({ count: 1, summary: 'agentic 0.5 waits on signalx#14' });
        expect(liveLinksData(undefined, names)).toEqual({ open: { lanes: [], items: [] }, done: { lanes: [], items: [] } });
    });

    it('has no strip without open links, and keeps two same-named projects apart', async () => {
        const quiet = await readLinkGraphs(PROJECTS, async () => []);
        expect(openLinksOf(quiet.open)).toBeUndefined();
        const twins: LinkProjectInfo[] = [{ id: A, name: 'x', manager: null }, { id: S, name: 'x', manager: null }];
        const g = await readLinkGraphs(twins, async (id) => (id === A ? [input(item(1, 'A', 'ready'), [{ projectId: S, n: 1 }])] : [input(item(1, 'B', 'ready'))]));
        const refs = linksViewOf(g.open, names).items.map((i) => i.ref);
        expect(new Set(refs).size).toBe(2);
    });

    it('takes the PM agent as the lane manager before the coordinator', () => {
        const p = { id: A, name: 'agentic', members: { coordinator: 'agent_c' }, pm: { agentId: 'agent_pm' } } as unknown as ProjectRecord;
        expect(linkProjectOf(p).manager).toBe('agent_pm');
        expect(linkProjectOf({ ...p, pm: undefined } as unknown as ProjectRecord).manager).toBe('agent_c');
    });
});
