/**
 * The Plan list's detail panel on a done item (#909): since #906 a done item keeps the claim it finished under
 * (lease spent), and the panel names the task that finished it instead of calling the lease run out.
 */
import { describe, it, expect } from 'vitest';
import type { AgentId, PlanItem, TaskId } from '@agentic/core';
import { MOCK_PLANS } from '../../src/mock/projects/plan';
import { ItemDetail } from '../../src/pages/projects/features/plan/list/ItemDetail';
import { mountAt, text } from '../pages/helpers';

const doc = MOCK_PLANS['p_agentic']![0]!;
const items = doc.plan.phases.flatMap((p) => p.items);
const now = 10_000_000;

const mount = (item: PlanItem): Promise<HTMLDivElement> =>
    mountAt('/projects/p_agentic/plan', <ItemDetail projectId="p_agentic" doc={doc} item={item} items={items} now={now} onPick={() => {}} onClose={() => {}} />);

const done = (claim: PlanItem['claim']): PlanItem => ({ ...items.find((i) => i.state === 'done')!, claim });

describe('the plan item detail on a done item (#909)', () => {
    it('names the task that finished it, never "lease ran out"', async () => {
        const el = await mount(done({ agentId: 'forge' as AgentId, leaseUntil: now - 60_000, taskId: 't_done' as TaskId }));
        const fact = el.querySelector('[data-fact="claimed"]')!;
        expect(text(fact)).toBe('finished by t_done');
        expect(fact.querySelector('a[data-plan-chip="task"]')?.getAttribute('href')).toBe('/tasks/t_done');
        expect(text(fact)).not.toContain('lease');
    });

    it('says only Done when the claim carries no task', async () => {
        const el = await mount(done({ agentId: 'forge' as AgentId, leaseUntil: now - 60_000 }));
        expect(text(el.querySelector('[data-fact="claimed"]'))).toBe('Done');
    });

    it('still says the lease ran out on an open item whose claim lapsed', async () => {
        const open = { ...items.find((i) => i.state !== 'done')!, state: 'ready' as const, claim: { agentId: 'forge' as AgentId, leaseUntil: now - 60_000 } };
        const el = await mount(open);
        expect(text(el.querySelector('[data-fact="claimed"]'))).toBe('lease ran out');
    });
});
