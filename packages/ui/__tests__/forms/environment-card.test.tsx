import type { EnvironmentDescriptor, EnvironmentId, MachineId, MachineInfo, QuotaSnapshot } from '@agentic/core';
import { EnvironmentCard, authFixLine, authPill, environmentStatus } from '@agentic/ui';
import { mount } from './helpers';

const env = (patch: Partial<EnvironmentDescriptor> = {}): EnvironmentDescriptor => ({
    id: 'env_1' as EnvironmentId,
    machineId: 'machine_1' as MachineId,
    name: 'laptop / work',
    runtime: 'claude-code',
    account: { label: 'work', authStatus: 'ok', identity: 'andy@acme' },
    cwdRoots: ['C:/Dev'],
    concurrency: { max: 2, active: 1 },
    isolation: 'config-dir',
    ...patch
});
const machine = (patch: Partial<MachineInfo> = {}): MachineInfo => ({ id: 'machine_1' as MachineId, name: 'Laptop', os: 'windows', daemonVersion: '0.1.0', online: true, lastSeenAt: 0, ...patch });
const card = (root: ParentNode): HTMLElement => root.querySelector<HTMLElement>('[data-scope="ag-env-card"][data-part="root"]')!;
const part = (root: ParentNode, name: string): HTMLElement | null => root.querySelector<HTMLElement>(`[data-scope="ag-env-card"][data-part="${name}"]`);

describe('environmentStatus', () => {
    it('ranks offline over auth over capacity, with the card tone per state', () => {
        expect(environmentStatus(env(), machine())).toMatchObject({ state: 'ready', tone: 'live' });
        expect(environmentStatus(env({ account: { label: 'w', authStatus: 'expired' } }), machine({ online: false }))).toMatchObject({ state: 'offline', tone: 'dim' });
        expect(environmentStatus(env({ account: { label: 'w', authStatus: 'expired' }, concurrency: { max: 1, active: 1 } }))).toMatchObject({ state: 'auth-expired', tone: 'failed' });
        expect(environmentStatus(env({ account: { label: 'w', authStatus: 'missing' } }))).toMatchObject({ state: 'auth-missing', tone: 'failed' });
        expect(environmentStatus(env({ account: { label: 'w', authStatus: 'unknown' } })).color).toBe('warning');
        expect(environmentStatus(env({ concurrency: { max: 1, active: 1 } }))).toMatchObject({ state: 'busy', tone: 'working' });
    });

    it('names the auth pill and the fix line', () => {
        expect(authPill(env())).toBe('auth-ok');
        expect(authPill(env({ account: { label: 'w', authStatus: 'expired' } }))).toBe('auth-expired');
        expect(authFixLine(env())).toBeUndefined();
        expect(authFixLine(env({ account: { label: 'client-acme', authStatus: 'expired' } }))).toContain('client-acme');
    });
});

describe('EnvironmentCard', () => {
    // Every environment state of the handoff table, in one place.
    it.each([
        ['ready', env(), machine(), 'live', 'AUTH OK', false],
        ['busy', env({ concurrency: { max: 2, active: 2 } }), machine(), 'working', 'AUTH OK', false],
        ['offline', env(), machine({ online: false }), 'dim', 'AUTH OK', false],
        ['auth-expired', env({ account: { label: 'client-acme', authStatus: 'expired' } }), machine(), 'failed', 'AUTH EXPIRED', true],
        ['auth-missing', env({ account: { label: 'w', authStatus: 'missing' } }), machine(), 'failed', 'NOT SIGNED IN', true],
        ['auth-unknown', env({ account: { label: 'w', authStatus: 'unknown' } }), machine(), 'muted', 'UNKNOWN', false]
    ] as const)('renders the %s state', (state, e, m, tone, pill, fix) => {
        const root = mount(<EnvironmentCard environment={e} machine={m} />);
        expect(card(root).getAttribute('data-env-state')).toBe(state);
        expect(card(root).getAttribute('data-tone')).toBe(tone);
        expect(root.querySelector('[data-scope="ag-pill"][data-part="label"]')!.textContent).toBe(pill);
        expect(part(root, 'fix') !== null).toBe(fix);
    });

    it('shows runtime, account, machine, capacity, isolation and roots (EXE-06)', () => {
        const root = mount(<EnvironmentCard environment={env()} machine={machine()} queued={1} defaultFor={[{ name: 'Forge', hue: 2 }]} />);
        expect(root.querySelector('h3')!.textContent).toBe('laptop / work');
        expect(part(root, 'line')!.textContent).toContain('claude-code');
        expect(part(root, 'line')!.textContent).toContain('work (andy@acme)');
        const text = root.textContent!;
        expect(text).toContain('Laptop — online');
        expect(text).toContain('1 of 2');
        expect(text).toContain('config-dir');
        expect(text).toContain('C:/Dev');
        expect(part(root, 'capacity')!.getAttribute('aria-label')).toBe('1 of 2 sessions in use');
        const slots = [...root.querySelectorAll('[data-scope="ag-env-card"][data-part="slot"]')];
        expect(slots.map((s) => s.hasAttribute('data-used'))).toEqual([true, false]);
        expect(part(root, 'queued')!.textContent).toBe('1 queued');
        expect(part(root, 'default-for')!.querySelector('[data-scope="ag-agent-tile"]')!.getAttribute('aria-label')).toBe('Forge');
        expect(root.querySelector('[data-scope="status"]')!.getAttribute('data-color')).toBe('success');
        expect(root.querySelector('button')).toBeNull();
    });

    it('falls back to the machine id and marks an offline machine', () => {
        const root = mount(<EnvironmentCard environment={env()} machine={machine({ online: false })} />);
        expect(card(root).getAttribute('data-env-state')).toBe('offline');
        expect(root.textContent).toContain('Laptop — offline');
        const noMachine = mount(<EnvironmentCard environment={env()} />);
        expect(noMachine.textContent).toContain('machine_1');
    });

    it('offers Re-check on the fix line when auth expired', () => {
        const rechecked: string[] = [];
        const root = mount(<EnvironmentCard environment={env({ account: { label: 'client-acme', authStatus: 'expired' } })} onRecheck={(id) => rechecked.push(id)} />);
        const fix = part(root, 'fix')!;
        expect(fix.textContent).toContain('client-acme');
        fix.querySelector('button')!.click();
        expect(rechecked).toEqual(['env_1']);
    });

    it('offers a select action that emits the environment id', () => {
        const picked: string[] = [];
        const root = mount(<EnvironmentCard environment={env()} selectLabel="Use here" onSelect={(id) => picked.push(id)} />);
        const button = root.querySelector('button')!;
        expect(button.textContent).toBe('Use here');
        button.click();
        expect(picked).toEqual(['env_1']);
        const selected = mount(<EnvironmentCard environment={env()} selected selectLabel="Use here" />);
        expect(card(selected).hasAttribute('data-mod-selected')).toBe(true);
        expect(selected.querySelector('button')!.disabled).toBe(true);
    });
});

describe('EnvironmentCard quota (#270)', () => {
    const quota: QuotaSnapshot = {
        sourceId: 'agentic.quota.claude-code',
        runtime: 'claude-code',
        environmentId: 'env_1' as EnvironmentId,
        availability: 'reported',
        windows: [{ id: 'seven_day', label: 'Current week (all models)', period: 'week', utilization: 0.76, unit: 'percent', status: 'ok' }],
        observedAt: Date.now(),
        via: 'probe'
    };

    it('shows the account limits when given, "No usage reported yet" for null, nothing when absent', () => {
        const withQuota = mount(<EnvironmentCard environment={env()} quota={quota} />);
        expect(part(withQuota, 'quota')!.querySelector('[data-scope="ag-quota"][data-part="used"]')!.textContent).toBe('76% used');
        expect(part(mount(<EnvironmentCard environment={env()} quota={null} />), 'quota')!.textContent).toContain('No usage reported yet');
        expect(part(mount(<EnvironmentCard environment={env()} />), 'quota')).toBeNull();
    });
});
