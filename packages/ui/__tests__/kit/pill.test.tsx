/**
 * One visual per domain state (`docs/design/HANDOFF.md` → "Task status"):
 * every row of the handoff table, plus the machine, auth and tool phases
 * the pill also shows; tags outline; wait lines in the literal core names.
 */
import type { TaskStatus, WaitReason } from '@agentic/core';
import { PILLS, StatusPill, Tag, WaitReasonLine, pillFor, waitText } from '@agentic/ui';
import { mount, one } from '../helpers';

const SCOPE = 'ag-pill';

// The handoff's task-status table, verbatim: pill text, colour (tone), dot.
const TASK_ROWS: { status: TaskStatus; label: string; tone: string; dot: 'hollow' | 'solid' }[] = [
    { status: 'queued', label: 'QUEUED', tone: 'muted', dot: 'hollow' },
    { status: 'active', label: 'ACTIVE', tone: 'working', dot: 'solid' },
    { status: 'waiting', label: 'WAITING', tone: 'needs-you', dot: 'solid' },
    { status: 'completed', label: 'COMPLETED', tone: 'muted', dot: 'solid' },
    { status: 'failed', label: 'FAILED', tone: 'failed', dot: 'solid' },
    { status: 'cancelled', label: 'CANCELLED', tone: 'dim', dot: 'hollow' }
];

describe('StatusPill', () => {
    it.each(TASK_ROWS)('renders $status as $label in $tone with a $dot dot', ({ status, label, tone, dot }) => {
        const root = mount(<StatusPill status={status} />);
        const pill = one(root, SCOPE, 'root')!;
        expect(pill.getAttribute('data-tone')).toBe(tone);
        expect(pill.hasAttribute('data-mod-hollow')).toBe(dot === 'hollow');
        expect(one(root, SCOPE, 'label')!.textContent).toBe(label);
        expect(one(root, SCOPE, 'dot')!.getAttribute('aria-hidden')).toBe('true');
    });

    it.each([
        ['online', 'live', false],
        ['offline', 'muted', true],
        ['unknown', 'muted', true],
        ['denied', 'failed', true],
        ['running', 'working', false],
        ['auth-expired', 'failed', false]
    ] as const)('knows %s (tone %s, hollow %s)', (status, tone, hollow) => {
        const spec = pillFor(status);
        expect(spec.tone).toBe(tone);
        expect(spec.hollow).toBe(hollow);
    });

    it('renders free text muted with a solid dot, and takes a label override', () => {
        expect(pillFor('anything else')).toEqual({ tone: 'muted', hollow: false, label: 'anything else' });
        const root = mount(<StatusPill status="current" label="CURRENT" tone="live" />);
        expect(one(root, SCOPE, 'root')!.getAttribute('data-tone')).toBe('live');
        expect(one(root, SCOPE, 'label')!.textContent).toBe('CURRENT');
    });

    it('has a row for every TaskStatus', () => {
        for (const row of TASK_ROWS) expect(PILLS[row.status]).toBeDefined();
    });
});

describe('Tag', () => {
    it('is outline only, muted unless toned', () => {
        const root = mount(<Tag>memory</Tag>);
        const tag = one(root, SCOPE, 'root')!;
        expect(tag.hasAttribute('data-mod-outline')).toBe(true);
        expect(tag.getAttribute('data-tone')).toBe('muted');
        expect(tag.textContent).toBe('memory');
        const toned = mount(<Tag tone="needs-you">approval</Tag>);
        expect(one(toned, SCOPE, 'root')!.getAttribute('data-tone')).toBe('needs-you');
    });
});

describe('WaitReasonLine', () => {
    const sid = 's_1' as never;
    it.each<[WaitReason, string]>([
        [{ kind: 'approval', requestId: 'r', sessionId: sid }, 'wait: approval · git push'],
        [{ kind: 'input', requestId: 'r' }, 'wait: input · git push'],
        [{ kind: 'environment-offline', environmentId: 'e' as never, policy: 'queue' }, 'wait: environment-offline · policy queue · git push'],
        [{ kind: 'child', childTaskIds: ['a', 'b'] as never }, 'wait: child · 2 tasks · git push'],
        [{ kind: 'capacity', environmentId: 'e' as never, position: 3 }, 'wait: capacity · position 3 · git push'],
        [{ kind: 'budget', limit: 'maxCostUsd' as never }, 'wait: budget · maxCostUsd · git push']
    ])('prints the literal core name for %j', (wait, text) => {
        expect(waitText(wait, 'git push')).toBe(text);
        const root = mount(<WaitReasonLine wait={wait} detail="git push" />);
        const line = root.querySelector('[data-part="wait"]')!;
        expect(line.textContent).toBe(text);
        expect(line.getAttribute('data-wait')).toBe(wait.kind);
    });

    it('drops the detail when none is known', () => {
        expect(waitText({ kind: 'input', requestId: 'r' })).toBe('wait: input');
    });
});
