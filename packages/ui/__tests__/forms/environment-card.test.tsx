import type { EnvironmentDescriptor, EnvironmentId, MachineId, MachineInfo } from '@agentic/core';
import { EnvironmentCard, environmentStatus } from '@agentic/ui';
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

describe('environmentStatus', () => {
    it('ranks offline over auth over capacity', () => {
        expect(environmentStatus(env(), machine()).state).toBe('ready');
        expect(environmentStatus(env({ account: { label: 'w', authStatus: 'expired' } }), machine({ online: false })).state).toBe('offline');
        expect(environmentStatus(env({ account: { label: 'w', authStatus: 'expired' }, concurrency: { max: 1, active: 1 } })).state).toBe('auth-expired');
        expect(environmentStatus(env({ account: { label: 'w', authStatus: 'missing' } })).state).toBe('auth-missing');
        expect(environmentStatus(env({ account: { label: 'w', authStatus: 'unknown' } })).color).toBe('warning');
        expect(environmentStatus(env({ concurrency: { max: 1, active: 1 } })).state).toBe('busy');
    });
});

describe('EnvironmentCard', () => {
    it('shows runtime, account, machine and status (EXE-06)', () => {
        const root = mount(<EnvironmentCard environment={env()} machine={machine()} />);
        const card = root.querySelector<HTMLElement>('[data-part="environment"]')!;
        expect(card.getAttribute('data-state')).toBe('ready');
        expect(root.querySelector('h3')!.textContent).toBe('laptop / work');
        const text = root.textContent!;
        expect(text).toContain('claude-code');
        expect(text).toContain('work (andy@acme)');
        expect(text).toContain('Laptop — online');
        expect(text).toContain('1 of 2');
        expect(text).toContain('config-dir');
        expect(text).toContain('C:/Dev');
        expect(root.querySelector('[data-scope="status"]')!.getAttribute('data-color')).toBe('success');
        expect(root.querySelector('button')).toBeNull();
    });

    it('falls back to the machine id and marks an offline machine', () => {
        const root = mount(<EnvironmentCard environment={env()} machine={machine({ online: false })} />);
        expect(root.querySelector('[data-part="environment"]')!.getAttribute('data-state')).toBe('offline');
        expect(root.textContent).toContain('Laptop — offline');
        const noMachine = mount(<EnvironmentCard environment={env()} />);
        expect(noMachine.textContent).toContain('machine_1');
    });

    it('offers a select action that emits the environment id', () => {
        const picked: string[] = [];
        const root = mount(<EnvironmentCard environment={env()} selectLabel="Use here" onSelect={(id) => picked.push(id)} />);
        const button = root.querySelector('button')!;
        expect(button.textContent).toBe('Use here');
        button.click();
        expect(picked).toEqual(['env_1']);
        const selected = mount(<EnvironmentCard environment={env()} selected selectLabel="Use here" />);
        expect(selected.querySelector('[data-part="environment"]')!.getAttribute('data-selected')).toBe('');
        expect(selected.querySelector('button')!.disabled).toBe(true);
    });
});
