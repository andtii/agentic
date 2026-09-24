import { describe, it, expect } from 'vitest';
import { loadTask, loadTasks } from '../../src/mock/workspace';
import { topbarFor } from '../../src/components/topbar';
import { mountRoute, page, all, texts, tick } from './mount';
import { colWidths } from './helpers';

describe('/tasks (Tasks)', () => {
    it('renders every task in the Home table template with filter chips by status', async () => {
        const dom = await mountRoute('/tasks');
        expect(page(dom, 'tasks')).not.toBeNull();
        expect(colWidths(dom)).toEqual(['100px', 'auto', '140px', '270px', '60px']);
        expect(dom.querySelectorAll('tbody tr')).toHaveLength(loadTasks().length);
        const chips = [...dom.querySelectorAll<HTMLButtonElement>('[data-filter-chips] [data-part="item"]')];
        expect(chips.map((c) => c.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false', 'false', 'false', 'false', 'false']);
        chips.find((c) => c.textContent!.startsWith('Waiting'))!.click();
        await tick();
        expect(dom.querySelectorAll('tbody tr')).toHaveLength(loadTasks().filter((t) => t.status === 'waiting').length);
        expect(dom.querySelector('[data-filter-chips] [aria-pressed="true"]')!.textContent).toContain('Waiting');
    });
});

describe('/tasks/:id (Task)', () => {
    it('renders the delegation tree with the depth counter and the selected node in the rail', async () => {
        const dom = await mountRoute('/tasks/t1-1');
        expect(page(dom, 'task')).not.toBeNull();
        expect(dom.querySelector('[data-task-tree]')?.getAttribute('aria-label')).toBe('Delegation tree');
        expect(dom.querySelector('[data-tree-head]')!.textContent).toContain('depth 2 of 3');
        const nodes = all(dom, 'ag-task-node', 'root');
        expect(nodes).toHaveLength(3);
        expect(nodes.map((n) => n.getAttribute('data-depth'))).toEqual(['0', '1', '1']);
        expect(nodes.map((n) => n.hasAttribute('data-mod-selected'))).toEqual([false, true, false]);
        // The rail shows the selected node's contract in key-value rows.
        const rail = dom.querySelector('[data-task-rail]')!;
        expect(rail.getAttribute('aria-label')).toBe('Selected task');
        expect(rail.querySelector('[data-ref]')!.textContent).toBe('t_8f2c');
        expect(texts([...rail.querySelectorAll('[data-kv-row] > dt')])).toEqual(['Objective', 'Origin', 'Assignee', 'Environment', 'Constraints', 'Expected', 'Config', 'Limits']);
        expect(rail.textContent).toContain('NOT VERIFIED');
    });

    it('selecting a node swaps the rail and moves the approval card with it', async () => {
        const dom = await mountRoute('/tasks/t1-1');
        expect(dom.querySelector('[data-task-tree] [data-scope="ai-approval"]')).not.toBeNull();
        const cards = all(dom, 'ag-task-node', 'card') as HTMLButtonElement[];
        cards[2]!.click();
        await tick();
        expect(dom.querySelector('[data-task-rail] [data-ref]')!.textContent).toBe('t_8f2d');
        expect(dom.querySelector('[data-task-tree] [data-scope="ai-approval"]')).toBeNull();
        expect(all(dom, 'ag-task-node', 'root').map((n) => n.hasAttribute('data-mod-selected'))).toEqual([false, false, true]);
    });

    it('renders the transitions timeline for the selected node', async () => {
        const dom = await mountRoute('/tasks/t1-1');
        const entries = texts([...dom.querySelectorAll('[data-timeline-text]')]);
        expect(entries).toEqual(['queued · created by Atlas', 'active · session s_41aa opened on alien01', 'waiting · approval · Bash git push']);
    });

    it('contributes the root objective as the breadcrumb label and the stop-chain action', () => {
        const contribution = topbarFor({ name: 'task', path: '/tasks/t1-1', params: { id: 't1-1' } });
        expect(contribution?.crumb).toBe(loadTask('t1-1')!.root.objective);
        expect(contribution?.actions).toBeTypeOf('function');
    });
});
