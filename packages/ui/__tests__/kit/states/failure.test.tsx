/**
 * The six named failure states (OPS-04): each renders its own name, kind,
 * tone, signal and action — no two collapse into one look.
 */
import { FAILURES, FAILURE_KINDS, FailureCard, OfflineBanner, EventsLostRow, eventsLostText, failureSpec } from '@agentic/ui';
import { KINDS } from '../../../src/design-system';
import { buttonNamed, mount, one } from '../../helpers';

describe('FailureCard', () => {
    it('renders all six kinds with distinct names, kinds, tones and actions', () => {
        const root = mount(<div>{FAILURE_KINDS.map((kind) => <FailureCard kind={kind} />)}</div>);
        const cards = [...root.querySelectorAll<HTMLElement>('[data-scope="ag-failure"][data-part="root"]')];
        expect(cards).toHaveLength(6);
        const names = cards.map((c) => one(c, 'ag-failure', 'name')!.textContent);
        const kinds = cards.map((c) => c.getAttribute('data-kind'));
        const actions = cards.map((c) => c.querySelector('[data-scope="button"]')!.textContent!.trim());
        expect(new Set(names).size).toBe(6);
        expect(new Set(kinds).size).toBe(6);
        expect(new Set(names.map((n, i) => `${n}|${actions[i]}`)).size).toBe(6);
        expect(names).toEqual(['This browser is offline', 'Machine disconnected', 'Sign-in needed on the machine', 'Runtime error', 'Task failed', 'Interrupted']);
        expect(actions).toEqual(['Reconnecting…', 'Open machine', 'Re-check', 'Retry turn', 'Open task', 'Resume']);
        expect(kinds).toEqual(['offline', 'machine', 'auth', 'runtime', 'task', 'interrupted']);
        for (const kind of kinds) expect(KINDS).toContain(kind);
    });

    it.each([
        ['client-offline', 'muted', 'client socket', 'wifi'],
        ['machine', 'needs-you', 'Machine.online', 'machines'],
        ['auth', 'needs-you', 'environment authStatus', 'key'],
        ['runtime', 'failed', 'adapter error event', 'terminal'],
        ['task', 'failed', 'Task.status', 'close'],
        ['interrupted', 'failed', 'last event is not turn-end', 'warning']
    ] as const)('%s is %s with its signal and icon', (kind, tone, signal, icon) => {
        const root = mount(<FailureCard kind={kind} />);
        const card = one(root, 'ag-failure', 'root')!;
        expect(card.getAttribute('data-tone')).toBe(tone);
        expect(card.getAttribute('data-failure')).toBe(kind);
        expect(card.getAttribute('role')).toBe('status');
        expect(card.getAttribute('aria-label')).toBe(FAILURES[kind].name);
        expect(one(card, 'ag-failure', 'signal')!.textContent).toBe(signal);
        expect(card.querySelector('svg')!.getAttribute('data-icon')).toBe(icon);
        expect(one(card, 'ag-failure', 'detail')!.textContent).toBe(failureSpec(kind).detail);
    });

    it('disables the browser-offline action, and wires button and link actions', () => {
        const offline = mount(<FailureCard kind="client-offline" />);
        expect(buttonNamed(offline, 'Reconnecting…').disabled).toBe(true);

        const clicks: string[] = [];
        const runtime = mount(<FailureCard kind="runtime" detail="claude-code exited with code 1." action={{ onAction: () => clicks.push('retry') }} />);
        expect(one(runtime, 'ag-failure', 'detail')!.textContent).toBe('claude-code exited with code 1.');
        buttonNamed(runtime, 'Retry turn').click();
        expect(clicks).toEqual(['retry']);

        const task = mount(<FailureCard kind="task" action={{ href: '/tasks/t_8f2c' }} signal="Task.status · t_8f2c" />);
        const link = task.querySelector<HTMLAnchorElement>('a[data-scope="button"]')!;
        expect(link.getAttribute('href')).toBe('/tasks/t_8f2c');
        expect(link.textContent!.trim()).toBe('Open task');
        expect(one(task, 'ag-failure', 'signal')!.textContent).toBe('Task.status · t_8f2c');

        const bare = mount(<FailureCard kind="interrupted" noAction />);
        expect(one(bare, 'ag-failure', 'actions')).toBeNull();
    });
});

describe('OfflineBanner', () => {
    it('is a polite status with the offline text and the reconnecting state', () => {
        const root = mount(<OfflineBanner />);
        const banner = one(root, 'ag-banner', 'root')!;
        expect(banner.getAttribute('role')).toBe('status');
        expect(banner.getAttribute('aria-live')).toBe('polite');
        expect(banner.getAttribute('data-tone')).toBe('muted');
        expect(one(banner, 'ag-banner', 'text')!.textContent).toBe('This browser is offline');
        expect(one(banner, 'ag-banner', 'state')!.textContent).toBe('Reconnecting…');
        expect(one(banner, 'ag-banner', 'actions')).toBeNull();
    });

    it('takes another tone, icon and an action for a machine banner', () => {
        const root = mount(<OfflineBanner tone="needs-you" icon="machines" message="alien01 disconnected" state="disconnected"><a href="/machines/m1">Open machine</a></OfflineBanner>);
        const banner = one(root, 'ag-banner', 'root')!;
        expect(banner.getAttribute('data-tone')).toBe('needs-you');
        expect(banner.querySelector('svg')!.getAttribute('data-icon')).toBe('machines');
        expect(one(banner, 'ag-banner', 'actions')!.querySelector('a')!.textContent).toBe('Open machine');
    });
});

describe('EventsLostRow', () => {
    it('prints the gap in amber mono as a list item or a div', () => {
        expect(eventsLostText(41, 57)).toBe('Events lost between seq 41 and 57');
        const li = mount(<ol><EventsLostRow from={41} to={57} /></ol>).querySelector('[data-events-lost]')!;
        expect(li.tagName).toBe('LI');
        expect(li.getAttribute('data-tone')).toBe('needs-you');
        expect(li.textContent).toBe('Events lost between seq 41 and 57');
        expect(mount(<EventsLostRow from={1} to={2} as="div" />).querySelector('[data-events-lost]')!.tagName).toBe('DIV');
    });
});
