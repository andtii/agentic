/**
 * One visual per domain state (`docs/design/HANDOFF.md` → "Task status"):
 * every row of the handoff table, plus the machine, auth and tool phases
 * the pill also shows; tags outline; wait lines in the literal core names.
 */
import type { TaskStatus, WaitReason } from '@agentic/core';
import { PILLS, StatusPill, Tag, WaitReasonLine, pillFor, roleOf, waitText } from '@agentic/ui';
import { mount, one } from '../helpers';

// A pill and a tag are zero's Badge; the kit's hooks ride its root.
const SCOPE = 'badge';

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
        expect(pill.getAttribute('data-status')).toBe(status);
        expect(pill.getAttribute('data-tone')).toBe(tone);
        // A hollow pill is the outline variant (its dot a ring); a solid one soft.
        expect(pill.getAttribute('data-variant')).toBe(dot === 'hollow' ? 'outline' : 'soft');
        expect(pill.textContent).toBe(label);
        expect(one(root, SCOPE, 'dot')!.getAttribute('aria-hidden')).toBe('true');
    });

    it.each([
        ['live', 'primary'],
        ['working', 'info'],
        ['needs-you', 'warning'],
        ['failed', 'error'],
        ['muted', 'neutral'],
        ['dim', 'neutral']
    ] as const)('paints the %s tone in the %s role', (tone, role) => {
        expect(roleOf(tone)).toBe(role);
        const pill = one(mount(<StatusPill status="x" tone={tone} />), SCOPE, 'root')!;
        expect(pill.getAttribute('data-color')).toBe(role);
        expect(pill.getAttribute('data-tone')).toBe(tone);
    });

    it('puts the dot of a working state in zero’s running state, and no other', () => {
        const dotOf = (status: string) => one(mount(<StatusPill status={status} />), SCOPE, 'dot')!;
        for (const status of ['active', 'running', 'streaming']) expect(dotOf(status).getAttribute('data-state'), status).toBe('running');
        for (const status of ['waiting', 'failed', 'queued', 'online']) expect(dotOf(status).hasAttribute('data-state'), status).toBe(false);
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
        expect(spec.role).toBe(roleOf(tone));
    });

    it('renders free text muted with a solid dot, and takes a label override', () => {
        expect(pillFor('anything else')).toEqual({ tone: 'muted', hollow: false, label: 'anything else', role: 'neutral' });
        const root = mount(<StatusPill status="current" label="CURRENT" tone="live" />);
        expect(one(root, SCOPE, 'root')!.getAttribute('data-tone')).toBe('live');
        expect(one(root, SCOPE, 'root')!.getAttribute('data-color')).toBe('primary');
        expect(one(root, SCOPE, 'root')!.textContent).toBe('CURRENT');
        expect(one(mount(<StatusPill status="online" hollow />), SCOPE, 'root')!.getAttribute('data-variant')).toBe('outline');
    });

    it('has a row for every TaskStatus', () => {
        for (const row of TASK_ROWS) expect(PILLS[row.status]).toBeDefined();
    });
});

describe('Tag', () => {
    it('is outline only with no dot, muted unless toned', () => {
        const root = mount(<Tag>memory</Tag>);
        const tag = one(root, SCOPE, 'root')!;
        expect(tag.getAttribute('data-variant')).toBe('outline');
        expect(tag.hasAttribute('data-tag')).toBe(true);
        expect(tag.hasAttribute('data-status')).toBe(false);
        expect(tag.getAttribute('data-tone')).toBe('muted');
        expect(tag.getAttribute('data-color')).toBe('neutral');
        expect(one(root, SCOPE, 'dot')).toBeNull();
        expect(tag.textContent).toBe('memory');
        const toned = mount(<Tag tone="needs-you">approval</Tag>);
        expect(one(toned, SCOPE, 'root')!.getAttribute('data-tone')).toBe('needs-you');
        expect(one(toned, SCOPE, 'root')!.getAttribute('data-color')).toBe('warning');
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
