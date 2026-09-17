/**
 * Empty states, skeleton presets and the connection strip's rows: the
 * handoff's "Edge cases" and the loading row of "Element states".
 */
import { CardSkeleton, ConnectionStrip, EMPTY_VARIANTS, EmptyState, RailSkeleton, TableSkeleton, browserRow, connectionRows, machineRow } from '@agentic/ui';
import { all, mount, one } from '../../helpers';

describe('EmptyState', () => {
    it('workspace is one card with the primary button to /agents', () => {
        const root = mount(<EmptyState variant="workspace" />);
        const card = one(root, 'ag-empty', 'root')!;
        expect(card.getAttribute('role')).toBe('status');
        expect(card.hasAttribute('data-mod-compact')).toBe(false);
        expect(one(card, 'ag-empty', 'title')!.textContent).toBe('Create your first agent');
        const link = one(card, 'ag-empty', 'actions')!.querySelector('a')!;
        expect(link.getAttribute('href')).toBe('/agents');
        expect(link.getAttribute('data-color')).toBe('primary');
    });

    it('inbox is the muted line only', () => {
        const root = mount(<EmptyState variant="inbox" />);
        const line = one(root, 'ag-empty', 'root')!;
        expect(line.hasAttribute('data-mod-compact')).toBe(true);
        expect(one(line, 'ag-empty', 'title')).toBeNull();
        expect(one(line, 'ag-empty', 'caption')!.textContent).toBe('Nothing needs you.');
        expect(one(line, 'ag-empty', 'actions')).toBeNull();
    });

    it('machines is the dashed "Pair a machine" card', () => {
        const root = mount(<EmptyState variant="machines" />);
        const card = one(root, 'ag-empty', 'root')!;
        expect(card.hasAttribute('data-mod-outline')).toBe(true);
        expect(one(card, 'ag-empty', 'title')!.textContent).toBe('Pair a machine');
        expect(one(card, 'ag-empty', 'actions')!.querySelector('a')!.getAttribute('href')).toBe('/pair');
    });

    it('chat is the activation hint, generic takes a title and caption, and actions can be replaced', () => {
        expect(one(mount(<EmptyState variant="chat" />), 'ag-empty', 'caption')!.textContent).toContain('@ to address an agent');
        const root = mount(<EmptyState title="No schedules yet" caption="Reminders run on the platform." slots={{ actions: () => <button type="button">New schedule</button> }} />);
        expect(one(root, 'ag-empty', 'root')!.getAttribute('data-empty')).toBe('generic');
        expect(one(root, 'ag-empty', 'title')!.textContent).toBe('No schedules yet');
        expect(one(root, 'ag-empty', 'caption')!.textContent).toBe('Reminders run on the platform.');
        expect(one(root, 'ag-empty', 'actions')!.querySelector('button')!.textContent).toBe('New schedule');
        expect(EMPTY_VARIANTS).toHaveLength(5);
    });
});

describe('skeleton presets', () => {
    it('TableSkeleton renders three busy rows in the column template', () => {
        const root = mount(<TableSkeleton cols="100px 1fr 60px" />);
        const wrap = root.querySelector<HTMLElement>('[data-skeleton="table"]')!;
        expect(wrap.getAttribute('aria-busy')).toBe('true');
        expect(wrap.getAttribute('role')).toBe('status');
        expect(wrap.querySelector('[data-visually-hidden]')!.textContent).toBe('Loading');
        const rows = wrap.querySelectorAll('[data-skeleton-row]');
        expect(rows).toHaveLength(3);
        expect(rows[0]!.getAttribute('style')).toContain('grid-template-columns: 100px 1fr 60px');
        expect(all(wrap, 'skeleton', 'root')).toHaveLength(9);
        expect(all(wrap, 'skeleton', 'root')[0]!.getAttribute('data-state')).toBe('loading');
    });

    it('CardSkeleton and RailSkeleton stack bars in card chrome', () => {
        const card = mount(<CardSkeleton lines={3} />).querySelector<HTMLElement>('[data-skeleton="card"]')!;
        expect(all(card, 'skeleton', 'root')).toHaveLength(4);
        const rail = mount(<RailSkeleton cards={2} />).querySelector<HTMLElement>('[data-skeleton="rail"]')!;
        const inner = rail.querySelectorAll<HTMLElement>('[data-skeleton="card"]');
        expect(inner).toHaveLength(2);
        expect(rail.getAttribute('aria-busy')).toBe('true');
        // One announcement: the nested cards carry no status semantics of their own.
        expect(rail.getAttribute('role')).toBe('status');
        expect(rail.querySelectorAll('[role="status"], [aria-busy]')).toHaveLength(0);
        expect(rail.querySelectorAll('[data-visually-hidden]')).toHaveLength(1);
        for (const c of inner) expect(c.getAttribute('aria-hidden')).toBe('true');
    });
});

describe('connection rows', () => {
    it('maps the browser and machine signals to rows, hollow when offline', () => {
        expect(browserRow('live')).toEqual({ id: 'browser', name: 'This browser', state: 'live', tone: 'live' });
        expect(browserRow('reconnecting')).toMatchObject({ state: 'reconnecting…', tone: 'muted', hollow: true });
        expect(machineRow({ id: 'm1', name: 'alien01', online: true, sessions: 2 })).toMatchObject({ state: '2 sessions', tone: 'live' });
        expect(machineRow({ id: 'm1', name: 'alien01', online: true, sessions: 1 }).state).toBe('1 session');
        expect(machineRow({ id: 'm1', name: 'alien01', online: true, sessions: 0 }).state).toBe('0 sessions');
        expect(machineRow({ id: 'm1', name: 'alien01', online: true })).toMatchObject({ state: 'online', tone: 'live' });
        expect(machineRow({ id: 'm2', name: 'nuc-lab', online: false, lastSeen: '3h' })).toMatchObject({ state: 'offline 3h', tone: 'muted', hollow: true });
        expect(machineRow({ id: 'm2', name: 'nuc-lab', online: false }).state).toBe('offline');
    });

    it('the strip renders a solid dot for online and a hollow dot for offline', () => {
        const rows = connectionRows('live', [
            { id: 'm1', name: 'alien01', online: true, sessions: 2 },
            { id: 'm2', name: 'nuc-lab', online: false, lastSeen: '3h' }
        ]);
        const root = mount(<ConnectionStrip rows={rows} />);
        const items = all(root, 'ag-connection', 'row');
        expect(items.map((r) => r.getAttribute('data-id'))).toEqual(['browser', 'm1', 'm2']);
        expect(items.map((r) => r.hasAttribute('data-mod-hollow'))).toEqual([false, false, true]);
        expect(items.map((r) => r.getAttribute('data-tone'))).toEqual(['live', 'live', 'muted']);
        expect(one(items[2]!, 'ag-connection', 'state')!.textContent).toBe('offline 3h');
    });
});
