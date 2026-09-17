import { describe, it, expect } from 'vitest';
import { HOME_TASK_COLS } from '../../src/pages/Home';
import { NEEDS, sortNeeds, loadHome } from '../../src/mock/workspace';
import { needsYouCount } from '../../src/nav';
import { mountRoute, page, all, texts } from './mount';

describe('/ (Home)', () => {
    it('renders the home page with its three regions and the tasks table template', async () => {
        const dom = await mountRoute('/');
        expect(page(dom, 'home')).not.toBeNull();
        expect(dom.querySelector('[data-page-title]')?.textContent).toBe('Home');
        expect(dom.querySelector('[data-home-needs]')?.getAttribute('aria-label')).toBe('Needs you');
        expect(dom.querySelector('[data-home-rail]')?.getAttribute('aria-label')).toBe('Today and spend');
        expect(dom.querySelector('[data-home-tasks]')?.getAttribute('aria-label')).toBe('Active tasks');
        // The table carries the handoff's column template as <col> widths.
        const cols = [...dom.querySelectorAll('[data-home-tasks] colgroup col')].map((c) => (c.getAttribute('style') ?? '').replace(/;$/, ''));
        expect(cols).toEqual(['width: 100px', '', 'width: 140px', 'width: 270px', 'width: 60px']);
        expect(HOME_TASK_COLS).toBe('100px 1fr 140px 270px 60px');
    });

    it('sorts "Needs you" approvals first, then input, then interrupted, oldest first inside each kind', async () => {
        const dom = await mountRoute('/');
        const kinds = all(dom, 'ag-needs-item', 'root').map((el) => el.getAttribute('data-kind'));
        expect(kinds).toEqual(['approval', 'input', 'interrupted']);
        // The order is the loader's, and the loader's is the handoff's.
        expect(sortNeeds(NEEDS).map((n) => n.kind)).toEqual(kinds);
        const shuffled = sortNeeds([NEEDS[2]!, NEEDS[0]!, NEEDS[1]!]);
        expect(shuffled.map((n) => n.id)).toEqual(['n1', 'n2', 'n3']);
    });

    it('renders the approval card inline under the approval item, with its context rows', async () => {
        const dom = await mountRoute('/');
        const approval = dom.querySelector('[data-scope="ag-needs-item"][data-kind="approval"] [data-scope="ai-approval"][data-part="root"]');
        expect(approval).not.toBeNull();
        expect(approval!.textContent).toContain('ask on destructive');
        expect(approval!.textContent).toContain('delegated by Atlas');
        expect(texts(all(approval!, 'button', 'root'))).toEqual(['Allow once', 'Allow for this session', 'Deny']);
    });

    it('counts the same items in the sidebar badge as it lists under Needs you', async () => {
        const dom = await mountRoute('/');
        expect(all(dom, 'ag-needs-item', 'root')).toHaveLength(needsYouCount());
        expect(loadHome().needs).toHaveLength(needsYouCount());
    });

    it('shows every active task with a status pill, the wait reason, the assignee tile and the environment line', async () => {
        const dom = await mountRoute('/');
        const rows = [...dom.querySelectorAll('[data-home-tasks] tbody tr')];
        expect(rows).toHaveLength(loadHome().tasks.length);
        const first = rows[0]!;
        expect(first.querySelector('[data-scope="ag-pill"]')).not.toBeNull();
        expect(first.querySelector('[data-scope="ag-task-node"][data-part="wait"]')?.textContent).toBe('wait: child · 2 tasks');
        expect(first.querySelector('[data-scope="ag-agent-tile"]')).not.toBeNull();
        expect(first.querySelector('[data-scope="ag-env-line"]')?.textContent).toBe('platform/anthropic-api/byo-key');
        // The queued task on the offline machine prints its policy.
        expect(dom.querySelector('[data-home-tasks]')!.textContent).toContain('wait: environment-offline · policy queue');
    });

    it('renders the spend against the limit and the schedule for today in the workspace zone', async () => {
        const dom = await mountRoute('/');
        expect(dom.querySelector('[data-spend-value]')?.textContent).toBe('$18.42');
        expect(dom.querySelector('[data-spend-bar]')?.getAttribute('aria-valuenow')).toBe('37');
        expect(dom.querySelector('[data-home-rail]')!.textContent).toContain('Today · Europe/Stockholm');
        expect(texts([...dom.querySelectorAll('[data-today-time]')])).toEqual(['15:00', '17:30', '02:00']);
    });
});
