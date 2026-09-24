/**
 * The row-shaped parts: the needs-you inbox row, the task node, the data
 * table, the connection strip, the version item, the section heading.
 */
import type { AgentConfigVersion, TaskId } from '@agentic/core';
import { AgentTile, ConnectionStrip, DataTable, Label, NeedsItem, SectionHeading, TaskNode, TimelineList, VersionItem, parseCols } from '@agentic/ui';
import { buttonNamed, mount, one } from '../helpers';

describe('NeedsItem', () => {
    it('carries its kind, the kind pill, the title, the context and the actions', () => {
        const root = mount(
            <NeedsItem kind="approval" title="Forge wants to run git push" age="2 min ago" slots={{ tile: () => <AgentTile name="Forge" hue={2} />, context: () => <span>delegated by Atlas</span> }}>
                <button type="button">Allow once</button>
            </NeedsItem>
        );
        const item = one(root, 'ag-needs-item', 'root')!;
        expect(item.getAttribute('data-kind')).toBe('approval');
        expect(item.getAttribute('aria-label')).toBe('Forge wants to run git push');
        expect(item.hasAttribute('data-mod-compact')).toBe(false);
        expect(one(root, 'badge', 'root')!.textContent).toBe('APPROVAL');
        expect(one(root, 'ag-needs-item', 'title')!.textContent).toBe('Forge wants to run git push');
        expect(one(root, 'ag-needs-item', 'context')!.textContent).toContain('delegated by Atlas');
        expect(one(root, 'ag-needs-item', 'context')!.textContent).toContain('2 min ago');
        expect(one(root, 'avatar', 'fallback')!.textContent).toBe('FO');
        expect(buttonNamed(one(root, 'ag-needs-item', 'actions')!, 'Allow once')).toBeTruthy();
    });

    it.each(['approval', 'input', 'interrupted'] as const)('renders the %s kind pill', (kind) => {
        const root = mount(<NeedsItem kind={kind} title="t" compact />);
        expect(one(root, 'ag-needs-item', 'root')!.hasAttribute('data-mod-compact')).toBe(true);
        expect(one(root, 'badge', 'root')!.textContent).toBe(kind.toUpperCase());
    });
});

describe('TaskNode', () => {
    const id = 't_8f2c' as TaskId;
    it('indents by depth, shows agent, environment, wait reason and status, and selects as a button', () => {
        const picked: string[] = [];
        const root = mount(
            <TaskNode id={id} title="Make the drawer collapse" status="waiting" agent="Forge" hue={2} depth={1}
                environment={{ machine: 'alien01', runtime: 'claude-code', account: 'work' }}
                wait={{ kind: 'approval', requestId: 'r', sessionId: 's' as never }} waitDetail="git push"
                onSelect={(v) => picked.push(v)} />
        );
        const node = one(root, 'ag-task-node', 'root')!;
        expect(node.getAttribute('data-depth')).toBe('1');
        expect(node.getAttribute('style')).toContain('--ag-depth: 1');
        expect(one(root, 'ag-task-node', 'rail')).not.toBeNull();
        const card = one(root, 'ag-task-node', 'card') as HTMLButtonElement;
        expect(card.tagName).toBe('BUTTON');
        expect(card.getAttribute('aria-pressed')).toBe('false');
        expect(one(root, 'ag-task-node', 'title')!.textContent).toBe('Make the drawer collapse');
        expect(one(root, 'ag-task-node', 'meta')!.textContent).toContain('Forge');
        expect(one(root, 'ag-env-line', 'root')!.getAttribute('data-tone')).toBe('dim');
        expect(one(root, 'ag-task-node', 'wait')!.textContent).toBe('wait: approval · git push');
        expect(one(root, 'badge', 'root')!.textContent).toBe('WAITING');
        card.click();
        expect(picked).toEqual([id]);
    });

    it('marks the selected node and has no rail at the root', () => {
        const root = mount(<TaskNode id={id} title="Root" status="active" agent="Atlas" selected />);
        expect(one(root, 'ag-task-node', 'root')!.hasAttribute('data-mod-selected')).toBe(true);
        expect(one(root, 'ag-task-node', 'card')!.getAttribute('aria-pressed')).toBe('true');
        expect(one(root, 'ag-task-node', 'rail')).toBeNull();
        expect(one(root, 'ag-task-node', 'wait')).toBeNull();
    });
});

describe('DataTable', () => {
    const columns = [{ label: 'Status' }, { label: 'Objective' }, { label: 'Age', align: 'end' as const }];

    it('turns the column template into col widths and labelled heads', () => {
        expect(parseCols('100px 1fr 60px')).toEqual(['100px', undefined, '60px']);
        const root = mount(
            <DataTable cols="100px 1fr 60px" columns={columns} label="Active tasks">
                <DataTable.Row><DataTable.Cell>a</DataTable.Cell><DataTable.Cell>b</DataTable.Cell><DataTable.Cell>c</DataTable.Cell></DataTable.Row>
            </DataTable>
        );
        const cols = [...root.querySelectorAll<HTMLElement>('col')].map((c) => c.style.width || null);
        expect(cols).toEqual(['100px', null, '60px']);
        expect([...root.querySelectorAll('th')].map((th) => th.textContent)).toEqual(['Status', 'Objective', 'Age']);
        expect(root.querySelector('th [data-align="end"]')!.textContent).toBe('Age');
        expect(root.querySelector('caption')!.textContent).toBe('Active tasks');
        expect(root.querySelectorAll('tbody td').length).toBe(3);
        expect(root.querySelector('[data-scope="table"][data-part="root"]')!.hasAttribute('data-mod-hover')).toBe(true);
    });

    it('captions every cell with its column head for the stacked layout below 768', () => {
        const root = mount(
            <DataTable cols="100px 1fr 60px" columns={[{ label: 'Status' }, { label: 'Objective' }, { label: 'Toggle', hidden: true }]} label="t">
                <DataTable.Row><DataTable.Cell>a</DataTable.Cell><DataTable.Cell>b</DataTable.Cell><DataTable.Cell>c</DataTable.Cell></DataTable.Row>
            </DataTable>
        );
        const wrapper = root.querySelector<HTMLElement>('[data-ag-table]')!;
        expect(wrapper).not.toBeNull();
        // Custom properties carry the captions; the kit CSS reads them into `td::before` per column. A hidden head captions nothing.
        expect(wrapper.style.getPropertyValue('--ag-col-1').trim()).toBe('"Status"');
        expect(wrapper.style.getPropertyValue('--ag-col-2').trim()).toBe('"Objective"');
        expect(wrapper.style.getPropertyValue('--ag-col-3').trim()).toBe('""');
        expect(wrapper.querySelector('[data-scope="table"][data-part="root"]')).not.toBeNull();
    });

    it('stands in three skeleton rows while loading', () => {
        const root = mount(<DataTable cols="1fr 1fr 1fr" columns={columns} label="t" loading />);
        expect(root.querySelectorAll('tbody tr').length).toBe(3);
        expect(root.querySelectorAll('tbody [data-scope="skeleton"]').length).toBe(9);
    });

    it('refuses a template that does not match the columns in development', () => {
        expect(() => mount(<DataTable cols="1fr 1fr" columns={columns} label="t" />)).toThrow(/tracks/);
    });
});

describe('ConnectionStrip', () => {
    it('renders one row per signal with its tone and a hollow dot when idle', () => {
        const root = mount(
            <ConnectionStrip rows={[
                { id: 'browser', name: 'This browser', state: 'live', tone: 'live' },
                { id: 'alien01', name: 'alien01', state: '2 sessions', tone: 'live' },
                { id: 'nuc-lab', name: 'nuc-lab', state: 'offline 3h', tone: 'muted', hollow: true }
            ]} />
        );
        const rows = [...root.querySelectorAll('[data-scope="ag-connection"][data-part="row"]')];
        expect(rows.length).toBe(3);
        expect(root.querySelector('ul')!.getAttribute('aria-label')).toBe('Connections');
        expect(rows.map((r) => r.getAttribute('data-tone'))).toEqual(['live', 'live', 'muted']);
        expect(rows.map((r) => r.hasAttribute('data-mod-hollow'))).toEqual([false, false, true]);
        expect(rows[2]!.textContent).toBe('nuc-laboffline 3h');
    });
});

describe('VersionItem', () => {
    const version: AgentConfigVersion = { version: 3, at: 0, by: 'learning', reason: 'Prefer pnpm over npm' };

    it('marks the current version, offers review and dismiss on a proposal, roll back on a past one', () => {
        const events: string[] = [];
        const current = mount(<VersionItem version={version} state="current" when="today" />);
        expect(one(current, 'ag-version', 'root')!.hasAttribute('data-mod-current')).toBe(true);
        expect(current.querySelector('button')).toBeNull();
        expect(one(current, 'badge', 'root')!.textContent).toBe('CURRENT');
        expect(one(current, 'ag-version', 'meta')!.textContent).toBe('today · learning');

        const proposed = mount(<VersionItem version={version} state="proposed" onReview={(v) => events.push(`review ${v}`)} onDismiss={(v) => events.push(`dismiss ${v}`)} />);
        expect(one(proposed, 'ag-version', 'root')!.getAttribute('data-tone')).toBe('needs-you');
        expect(one(proposed, 'badge', 'root')!.textContent).toBe('NEEDS REVIEW');
        buttonNamed(proposed, 'Review').click();
        buttonNamed(proposed, 'Dismiss').click();

        const past = mount(<VersionItem version={version} state="past" onRollback={(v) => events.push(`rollback ${v}`)} />);
        buttonNamed(past, 'Roll back to v3').click();
        expect(events).toEqual(['review 3', 'dismiss 3', 'rollback 3']);
    });
});

describe('TimelineList, SectionHeading, Label', () => {
    it('renders the entries with their tone and time, the heading with its count, the label voice', () => {
        const root = mount(
            <div>
                <SectionHeading count="3 open" slots={{ aside: () => <span>answer here</span> }}>Needs you</SectionHeading>
                <Label as="div">Today</Label>
                <TimelineList entries={[{ id: '1', text: 'queued → active', time: '14:02', tone: 'working' }, { id: '2', text: 'active → waiting', time: '14:09', tone: 'needs-you' }]} />
            </div>
        );
        expect(root.querySelector('h2')!.textContent).toBe('Needs you3 open');
        expect(root.querySelector('[data-section-aside]')!.textContent).toBe('answer here');
        expect(root.querySelector('[data-label]')!.textContent).toBe('Today');
        // Each marker is coloured by its tone's role and keeps the tone; the time's mono voice is the recipe's, not inline.
        const markers = [...root.querySelectorAll('[data-scope="timeline"][data-part="marker"]')];
        expect(markers.map((m) => m.getAttribute('data-tone'))).toEqual(['working', 'needs-you']);
        expect(markers.map((m) => m.getAttribute('data-color'))).toEqual(['info', 'warning']);
        expect(markers.every((m) => m.children.length === 0)).toBe(true);
        const times = [...root.querySelectorAll('time')];
        expect(times.map((t) => t.textContent)).toEqual(['14:02', '14:09']);
        expect(times.every((t) => !t.hasAttribute('style'))).toBe(true);
    });

    it('names the list by its label, and an entry without a tone is the muted neutral dot', () => {
        const root = mount(<TimelineList label="Task history" entries={[{ id: '1', text: 'created', time: '14:00' }]} />);
        expect(root.querySelector('[data-scope="timeline"][data-part="root"]')!.getAttribute('aria-label')).toBe('Task history');
        const marker = root.querySelector('[data-scope="timeline"][data-part="marker"]')!;
        expect(marker.getAttribute('data-tone')).toBe('muted');
        expect(marker.getAttribute('data-color')).toBe('neutral');
    });
});
