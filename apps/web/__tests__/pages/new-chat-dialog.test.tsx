/**
 * New chat (#315): the agents as cards — where each runs and how much of its account's plan is left — picked like
 * checkboxes, with the coordinator a radio on the picked cards once there is a group; none picked keeps it open.
 * With projects (#333): a picker at the top preselected from the last used project fills the roster; "No project"
 * keeps the plain flow and emits `projectId: null`. Opened from a folder (#336): the project naming its origin is
 * preselected and the folder offered as that project's folder; with none, "Just this chat" or a new project.
 */
import { describe, it, expect } from 'vitest';
import { signal } from 'sigx';
import type { EnvironmentDescriptor, EnvironmentId, QuotaSnapshot } from '@agentic/core';
import type { WorkdirEnvironment } from '@agentic/ui';
import { NewChatDialog, memberEnvironmentOn, openingMachine, permissionScope, type NewChatCreate, type NewChatProject } from '../../src/pages/chat/NewChatDialog';
import type { MachineEntry } from '../../src/pages/ops/environments';
import type { AgentIdentity } from '../../src/pages/chat/live';
import type { NewChatPrefill } from '../../src/pages/chat/new-chat-prefill';
import { mountAt, tick } from './helpers';

const WORK = 'env_alien01_work' as EnvironmentId;
const quota = (utilization: number): QuotaSnapshot => ({ sourceId: 'q', runtime: 'claude-code', environmentId: WORK, availability: 'reported', windows: [{ id: 'seven_day', label: 'Current week (all models)', period: 'week', utilization, unit: 'percent', status: utilization >= 0.8 ? 'warning' : 'ok' }], observedAt: Date.now(), via: 'probe' });
const environments: WorkdirEnvironment[] = [{ id: WORK, label: 'alien01 / work', os: 'windows', roots: ['C:\\Dev'], quota: quota(0.76) }];
const agents: AgentIdentity[] = [
    { id: 'forge', name: 'Forge', role: 'Developer', hue: 2, environment: { machine: 'alien01', runtime: 'claude-code', account: 'work' }, environmentId: WORK, configVersion: 1 },
    { id: 'atlas', name: 'Atlas', role: 'Assistant', hue: 1, environment: { machine: 'platform', runtime: 'anthropic-api', account: 'byo-key' }, configVersion: 1 },
    { id: 'lint', name: 'Lint', role: 'Reviewer', hue: 3, environment: { machine: 'unassigned', runtime: 'claude-code', account: 'machine' }, configVersion: 1 }
];
const projects: NewChatProject[] = [
    { id: 'p1' as never, name: 'agentic', members: { agentIds: ['forge', 'lint', 'gone'] as never[], coordinator: 'lint' as never }, folders: { [WORK]: 'C:\\Dev\\agentic\\main' }, connectors: [{ id: 'github-mcp' }], features: { 'agentic.feature.git': { origin: 'https://github.com/andtii/agentic.git' } } },
    { id: 'p2' as never, name: 'docs', members: { agentIds: ['atlas'] as never[], coordinator: null }, folders: {}, connectors: [], features: { 'agentic.feature.git': { origin: 'git@github.com:andtii/docs.git' } } }
];

async function open(extra: { projects?: readonly NewChatProject[]; lastProjectId?: string | null; prefill?: NewChatPrefill; machines?: readonly MachineEntry[]; lastMachineId?: string | null; agents?: readonly AgentIdentity[] } = {}) {
    const created: NewChatCreate[] = [];
    const projectsRequested: NewChatPrefill[] = [];
    const model = signal({ value: true });
    const root = await mountAt('/chats', <NewChatDialog model={() => model.value} agents={extra.agents ?? agents} environments={environments} {...(extra.projects ? { projects: extra.projects } : {})} {...(extra.prefill ? { prefill: extra.prefill } : {})} lastProjectId={extra.lastProjectId ?? null} {...(extra.machines ? { machines: extra.machines } : {})} lastMachineId={extra.lastMachineId ?? null} onCreate={(e) => created.push(e)} onCreateProject={(p) => projectsRequested.push(p)} />);
    const card = (id: string) => document.querySelector<HTMLElement>(`[data-new-chat-agent="${id}"]`)!;
    const pick = async (id: string) => {
        const box = card(id).querySelector<HTMLInputElement>('input[name="member"]')!;
        box.checked = !box.checked;
        box.dispatchEvent(new Event('change', { bubbles: true }));
        await tick();
    };
    const create = async () => {
        [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim().startsWith('Create chat'))!.click();
        await tick();
    };
    const picked = () => [...document.querySelectorAll<HTMLElement>('[data-new-chat-agent][data-picked]')].map((c) => c.getAttribute('data-new-chat-agent'));
    const select = () => document.querySelector<HTMLSelectElement>('select[name="chat-project"]');
    const choose = async (id: string) => {
        select()!.value = id;
        select()!.dispatchEvent(new Event('change', { bubbles: true }));
        select()!.dispatchEvent(new Event('input', { bubbles: true }));
        await tick();
    };
    const prefillBlock = () => document.querySelector<HTMLElement>('[data-new-chat-prefill]');
    const check = async (input: HTMLInputElement, on: boolean) => {
        input.checked = on;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await tick();
    };
    return { root, created, projectsRequested, card, pick, create, picked, select, choose, model, prefillBlock, check };
}

describe('New chat (#315)', () => {
    it('shows each agent where it runs and its account\u2019s limits', async () => {
        const { card } = await open();
        expect(card('forge').querySelector('[data-scope="ag-env-line"]')).not.toBeNull();
        expect(card('forge').querySelector('[data-new-chat-quota] [data-scope="ag-quota"][data-part="used"]')!.textContent).toBe('76% used');
        expect(card('atlas').querySelector('[data-new-chat-quota]')!.textContent).toBe('No plan limits · API key');
        expect(card('lint').querySelector('[data-new-chat-quota]')!.textContent).toBe('No environment chosen');
    });

    it('refuses to create with nobody picked, then offers the coordinator on picked cards of a group', async () => {
        const { card, pick, create, created, select } = await open();
        // No projects: no picker, and the plain flow.
        expect(select()).toBeNull();
        await create();
        expect(created).toEqual([]);
        expect(document.querySelector('[data-new-chat-required]')!.textContent).toBe('Pick at least one agent.');
        expect(document.querySelector('[data-new-chat-required]')!.getAttribute('role')).toBe('alert');
        await pick('forge');
        expect(card('forge').hasAttribute('data-picked')).toBe(true);
        expect(card('forge').querySelector('input[name="coordinator"]')).toBeNull();
        await pick('atlas');
        const radio = card('atlas').querySelector<HTMLInputElement>('input[name="coordinator"]')!;
        radio.checked = true;
        radio.dispatchEvent(new Event('change', { bubbles: true }));
        await tick();
        expect(document.querySelector('[data-new-chat-summary]')!.textContent).toContain('Atlas answers unless you mention someone');
        await create();
        expect(created).toEqual([{ agentIds: ['forge', 'atlas'], coordinator: 'atlas', projectId: null, machineId: null }]);
    });
});

describe('New chat from a folder (#336)', () => {
    const OTHER = 'env_nuclab_work' as EnvironmentId;
    const inAgentic = (environmentId: string, path: string): NewChatPrefill => ({ environmentId, path, origin: 'ssh://git@GitHub.com/andtii/agentic/' });

    it('the project naming the origin is preselected over the last used one; with no folder on that environment, the checked line saves it', async () => {
        const { select, picked, prefillBlock, create, created, check } = await open({ projects, lastProjectId: 'p2', prefill: inAgentic(OTHER, 'D:\\src\\agentic') });
        expect(select()!.value).toBe('p1');
        expect(picked()).toEqual(['forge', 'lint']);
        const save = prefillBlock()!.querySelector<HTMLInputElement>('input[name="chat-save-folder"]')!;
        expect(save.checked).toBe(true);
        expect(prefillBlock()!.textContent).toContain(`Save D:\\src\\agentic as this project's folder on ${OTHER}`);
        await create();
        expect(created).toEqual([{ agentIds: ['forge', 'lint'], coordinator: 'lint', projectId: 'p1', machineId: null, workdir: { environmentId: OTHER, path: 'D:\\src\\agentic', saveToProject: true } }]);
        // Unchecked: the chat runs there, the project is left alone.
        await check(save, false);
        await create();
        expect(created[1]!.workdir).toEqual({ environmentId: OTHER, path: 'D:\\src\\agentic', saveToProject: false });
    });

    it('on an environment the project has a folder on, nothing is saved; "No project" turns it into a plain folder for the members', async () => {
        const { select, prefillBlock, choose, create, created } = await open({ projects, lastProjectId: null, prefill: inAgentic(WORK, 'C:\\Dev\\agentic\\branches\\x') });
        expect(select()!.value).toBe('p1');
        expect(prefillBlock()!.querySelector('input[name="chat-save-folder"]')).toBeNull();
        expect(prefillBlock()!.textContent).toContain("the project's folder there is C:\\Dev\\agentic\\main");
        await create();
        expect(created[0]!.workdir).toEqual({ environmentId: WORK, path: 'C:\\Dev\\agentic\\branches\\x', saveToProject: false });
        await choose('');
        expect(prefillBlock()!.querySelector('[data-new-chat-prefill-choice]')).not.toBeNull();
    });

    it('with no project for the origin: "Just this chat" by default, or "Create project from this folder", which asks the caller for the form', async () => {
        const prefill: NewChatPrefill = { environmentId: WORK, path: 'C:\\Dev\\thing', origin: 'https://github.com/andtii/thing.git' };
        const { select, prefillBlock, pick, create, created, projectsRequested, check } = await open({ projects, lastProjectId: 'p1', prefill });
        // The last used project is not assumed for another repo.
        expect(select()!.value).toBe('');
        const radios = [...prefillBlock()!.querySelectorAll<HTMLInputElement>('input[name="chat-prefill-mode"]')];
        expect(radios.map((r) => [r.value, r.checked])).toEqual([['chat', true], ['project', false]]);
        await pick('forge');
        await create();
        expect(created).toEqual([{ agentIds: ['forge'], coordinator: null, projectId: null, machineId: null, workdir: { environmentId: WORK, path: 'C:\\Dev\\thing', saveToProject: false } }]);
        await check(radios[1]!, true);
        const confirm = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Create project');
        expect(confirm).toBeTruthy();
        confirm!.click();
        await tick();
        expect(projectsRequested).toEqual([prefill]);
        expect(created).toHaveLength(1);
    });

    it('a folder without an origin is a plain folder: the last used project stays, the choice is offered', async () => {
        const { select, prefillBlock } = await open({ projects, lastProjectId: 'p2', prefill: { environmentId: WORK, path: 'C:\\notes' } });
        expect(select()!.value).toBe('p2');
        // p2 has no folder on WORK: the line offers to save it.
        expect(prefillBlock()!.querySelector('input[name="chat-save-folder"]')).not.toBeNull();
    });
});

describe('New chat in a project (#333)', () => {
    it('preselects the last used project and fills the members and the coordinator from it; the line says its connectors and folders', async () => {
        const { picked, select, card, create, created } = await open({ projects, lastProjectId: 'p1' });
        expect(select()!.value).toBe('p1');
        // The roster the project names, minus an agent the workspace no longer has; the coordinator as a radio on its card.
        expect(picked()).toEqual(['forge', 'lint']);
        expect(card('lint').querySelector<HTMLInputElement>('input[name="coordinator"]')!.checked).toBe(true);
        expect(document.querySelector('[data-new-chat-project-line]')!.textContent).toBe('Connectors: github-mcp · alien01 / work: C:\\Dev\\agentic\\main');
        await create();
        expect(created).toEqual([{ agentIds: ['forge', 'lint'], coordinator: 'lint', projectId: 'p1', machineId: null }]);
    });

    it('picking another project replaces the roster; "No project" keeps the roster editable and emits null; an unknown last project starts on none', async () => {
        const { picked, select, choose, pick, create, created } = await open({ projects, lastProjectId: 'p_gone' });
        expect(select()!.value).toBe('');
        expect(picked()).toEqual([]);
        await choose('p2');
        expect(picked()).toEqual(['atlas']);
        expect(document.querySelector('[data-new-chat-project-line]')!.textContent).toBe('No connectors · no folders yet');
        await choose('p1');
        expect(picked()).toEqual(['forge', 'lint']);
        await choose('');
        expect(document.querySelector('[data-new-chat-project-line]')).toBeNull();
        await pick('lint');
        expect(picked()).toEqual(['forge']);
        await create();
        expect(created).toEqual([{ agentIds: ['forge'], coordinator: null, projectId: null, machineId: null }]);
    });

    it('each opening starts afresh: on the last used project’s roster, or on nobody when there is none', async () => {
        const { picked, pick, model } = await open({ projects, lastProjectId: 'p1' });
        await pick('forge');
        expect(picked()).toEqual(['lint']);
        model.value = false;
        await tick();
        model.value = true;
        await tick();
        expect(picked()).toEqual(['forge', 'lint']);
    });

    it('a plain opening emits no workdir', async () => {
        const { pick, create, created } = await open({ projects, lastProjectId: 'p2' });
        await pick('forge');
        await create();
        expect(created).toHaveLength(1);
        expect('workdir' in created[0]!).toBe(false);
    });

    it('without projects, reopening starts on nobody too', async () => {
        const { picked, pick, model } = await open();
        await pick('atlas');
        expect(picked()).toEqual(['atlas']);
        model.value = false;
        await tick();
        model.value = true;
        await tick();
        expect(picked()).toEqual([]);
    });
});

// ---- the machine (#414) --------------------------------------------------------------------------------------------

const env = (id: string, machineId: string, identity: string, authStatus: EnvironmentDescriptor['account']['authStatus'] = 'ok'): EnvironmentDescriptor => ({ id: id as EnvironmentId, machineId: machineId as never, name: id, runtime: 'claude-code', account: { label: id, authStatus, identity }, cwdRoots: ['C:\\Dev'], concurrency: { max: 1, active: 0 }, isolation: 'config-dir' });
const MAC: MachineEntry = { id: 'm_mac', name: 'mac', online: false, os: 'darwin', environments: [env('env_work', 'm_mac', 'me@work'), env('env_home', 'm_mac', 'me@home')] };
const PC: MachineEntry = { id: 'm_pc', name: 'pc', online: true, os: 'windows', environments: [env(WORK, 'm_pc', 'me@work')] };
const withAccounts: AgentIdentity[] = [
    { id: 'forge', name: 'Forge', role: 'Developer', hue: 2, environment: { machine: 'any machine', runtime: 'claude-code', account: 'me@work' }, account: { identity: 'me@work' }, configVersion: 1 },
    { id: 'homer', name: 'Homer', role: 'Home', hue: 3, environment: { machine: 'any machine', runtime: 'claude-code', account: 'me@home' }, account: { identity: 'me@home' }, configVersion: 1 },
    { id: 'pinned', name: 'Pinned', role: 'Legacy', hue: 4, environment: { machine: WORK, runtime: 'claude-code', account: 'machine' }, environmentId: WORK, configVersion: 1 },
    { id: 'atlas', name: 'Atlas', role: 'Assistant', hue: 1, environment: { machine: 'platform', runtime: 'anthropic-api', account: 'byo-key' }, configVersion: 1 }
];

describe('New chat on a machine (#414)', () => {
    it('openingMachine: the prefill\'s environment\'s machine, else the last used one, else the first online; memberEnvironmentOn: the pin as the machine reports it, else the account\'s login there', () => {
        expect(openingMachine([MAC, PC], null)).toBe('m_pc');
        expect(openingMachine([MAC, PC], 'm_mac')).toBe('m_mac');
        expect(openingMachine([MAC, PC], 'm_gone')).toBe('m_pc');
        expect(openingMachine([MAC, PC], 'm_mac', WORK)).toBe('m_pc');
        expect(openingMachine([], 'm_mac')).toBe('');
        expect(memberEnvironmentOn(withAccounts[0]!, MAC, [MAC, PC])).toBe('env_work');
        expect(memberEnvironmentOn(withAccounts[0]!, PC, [MAC, PC])).toBe(WORK);
        expect(memberEnvironmentOn(withAccounts[1]!, PC, [MAC, PC])).toBeUndefined();
        // A pinned agent: its environment where the machine reports it, else the login of that environment as any machine reports it.
        expect(memberEnvironmentOn(withAccounts[2]!, PC, [MAC, PC])).toBe(WORK);
        expect(memberEnvironmentOn(withAccounts[2]!, MAC, [MAC, PC])).toBe('env_work');
        expect(memberEnvironmentOn(withAccounts[3]!, PC, [MAC, PC])).toBeUndefined();
    });

    it('offers the paired machines online first, preselects the last used one, flags a picked member with no login there, and emits the choice', async () => {
        const d = await open({ machines: [MAC, PC], lastMachineId: 'm_mac', agents: withAccounts });
        const choices = () => [...document.querySelectorAll<HTMLElement>('[data-new-chat-machine-choice]')];
        expect(choices().map((c) => c.getAttribute('data-new-chat-machine-choice'))).toEqual(['m_pc', 'm_mac']);
        expect(choices().map((c) => c.querySelector('[data-new-chat-machine-name]')!.textContent)).toEqual(['pc · windows', 'mac · darwin · offline']);
        expect(document.querySelector<HTMLInputElement>('input[name="chat-machine"][value="m_mac"]')!.checked).toBe(true);
        // Picking Homer: signed in on the mac, not on the pc — a flag on the pc's row, no warning while the mac is chosen.
        await d.pick('homer');
        expect(document.querySelector('[data-new-chat-machine-choice="m_pc"] [data-new-chat-machine-account="homer"]')!.textContent).toBe('Homer: not signed in here');
        expect(document.querySelector('[data-new-chat-machine-choice="m_mac"] [data-new-chat-machine-account="homer"]')!.textContent).toBe('Homer: me@home signed in');
        expect(document.querySelector('[data-new-chat-machine-warning]')).toBeNull();
        // Choosing the pc warns, and never blocks.
        const pc = document.querySelector<HTMLInputElement>('input[name="chat-machine"][value="m_pc"]')!;
        pc.checked = true;
        pc.dispatchEvent(new Event('change', { bubbles: true }));
        await tick();
        expect(document.querySelector('[data-new-chat-machine-warning]')!.textContent).toMatch(/Homer has no login on pc/);
        // The cards' quota badges follow the chosen machine: Homer has no login on the pc, Forge's account is there.
        expect(d.card('homer').querySelector('[data-new-chat-quota]')!.textContent).toBe('Not signed in on pc');
        expect(d.card('forge').querySelector('[data-new-chat-quota] [data-scope="ag-quota"]')).not.toBeNull();
        await d.create();
        expect(d.created).toEqual([{ agentIds: ['homer'], coordinator: null, projectId: null, machineId: 'm_pc' }]);
    });

    it('a prefilled folder preselects the machine that reports its environment', async () => {
        await open({ machines: [MAC, PC], lastMachineId: 'm_mac', agents: withAccounts, prefill: { environmentId: WORK, path: 'C:\\Dev\\thing' } });
        expect(document.querySelector<HTMLInputElement>('input[name="chat-machine"][value="m_pc"]')!.checked).toBe(true);
    });

    it('with no machines the choice is absent and null is emitted', async () => {
        const bare = await open({ agents: withAccounts });
        expect(document.querySelector('[data-new-chat-machine]')).toBeNull();
        await bare.pick('forge');
        await bare.create();
        expect(bare.created).toEqual([{ agentIds: ['forge'], coordinator: null, projectId: null, machineId: null }]);
    });

    it('is a form dialog whose zero controls post under the names the hand-made inputs had (#592)', async () => {
        const d = await open({ machines: [MAC, PC], lastMachineId: 'm_mac', agents: withAccounts, prefill: { environmentId: 'env_nowhere' as EnvironmentId, path: '/tmp/thing' } });
        await d.pick('forge');
        const form = document.querySelector<HTMLFormElement>('form[data-form-dialog]')!;
        expect(form.closest('[data-scope="dialog"][data-part="popup"]')!.getAttribute('role')).not.toBe('alertdialog');
        // The machine and the folder choice are zero RadioGroups: one checked radio each, under the old names.
        expect([...form.querySelectorAll('[data-new-chat-machine] [role="radiogroup"], [data-new-chat-prefill-choice] [role="radiogroup"]')]).toHaveLength(2);
        const pc = form.querySelector<HTMLInputElement>('input[name="chat-machine"][value="m_pc"]')!;
        pc.click();
        await tick();
        const project = form.querySelector<HTMLInputElement>('input[name="chat-prefill-mode"][value="project"]')!;
        project.click();
        await tick();
        const fd = new FormData(form);
        expect(fd.getAll('member')).toEqual(['forge']);
        expect(fd.getAll('chat-machine')).toEqual(['m_pc']);
        expect(fd.getAll('chat-prefill-mode')).toEqual(['project']);
        // The submit button names the consequence; submitting hands the folder to the project form.
        const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
        expect(submit.textContent?.trim()).toBe('Create project');
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await tick();
        expect(d.projectsRequested).toEqual([{ environmentId: 'env_nowhere', path: '/tmp/thing' }]);
    });
});

// ---- the permission mode (#698) ------------------------------------------------------------------------------------

const bypassing = (e: EnvironmentDescriptor): EnvironmentDescriptor => ({ ...e, allowBypassPermissions: true });
const MAC_BYPASS: MachineEntry = { ...MAC, online: true, environments: MAC.environments.map(bypassing) };

describe('New chat permission mode (#698)', () => {
    const mode = () => document.querySelector<HTMLSelectElement>('select[name="chat-permission-mode"]');
    const modeOptions = () => [...mode()!.querySelectorAll('option')].map((o) => o.value).filter(Boolean);
    const pickMode = async (value: string) => {
        mode()!.value = value;
        mode()!.dispatchEvent(new Event('change', { bubbles: true }));
        mode()!.dispatchEvent(new Event('input', { bubbles: true }));
        await tick();
    };

    it('permissionScope: the Claude Code members; bypass only when each has an environment on the machine that allows it', () => {
        const [forge, homer, , atlas] = withAccounts;
        expect(permissionScope([forge!, atlas!], MAC_BYPASS, [MAC_BYPASS])).toEqual({ agentIds: ['forge'], bypassAllowed: true });
        expect(permissionScope([forge!, homer!], MAC, [MAC])).toEqual({ agentIds: ['forge', 'homer'], bypassAllowed: false });
        const halfMac: MachineEntry = { ...MAC, environments: [bypassing(MAC.environments[0]!), MAC.environments[1]!] };
        expect(permissionScope([forge!, homer!], halfMac, [halfMac])).toEqual({ agentIds: ['forge', 'homer'], bypassAllowed: false });
        expect(permissionScope([atlas!], MAC_BYPASS, [MAC_BYPASS])).toEqual({ agentIds: [], bypassAllowed: false });
        expect(permissionScope([forge!], undefined, [])).toEqual({ agentIds: ['forge'], bypassAllowed: false });
    });

    it('where the machine allows bypass it is the default, and the chat\'s Claude Code members start in it', async () => {
        const d = await open({ machines: [MAC_BYPASS], lastMachineId: 'm_mac', agents: withAccounts });
        // Nobody picked, or only an API agent: no choice.
        expect(mode()).toBeNull();
        await d.pick('atlas');
        expect(mode()).toBeNull();
        await d.pick('forge');
        expect(document.querySelector('[data-new-chat-permission]')!.getAttribute('data-mode')).toBe('bypassPermissions');
        expect(modeOptions()).toContain('bypassPermissions');
        expect(document.querySelector('[data-new-chat-permission-note]')).toBeNull();
        await d.create();
        expect(d.created).toEqual([{ agentIds: ['atlas', 'forge'], coordinator: null, projectId: null, machineId: 'm_mac', permissionMode: { mode: 'bypassPermissions', agentIds: ['forge'] } }]);
    });

    it('another mode can be picked; default sends nothing', async () => {
        const d = await open({ machines: [MAC_BYPASS], lastMachineId: 'm_mac', agents: withAccounts });
        await d.pick('forge');
        await pickMode('plan');
        expect(document.querySelector('[data-new-chat-permission]')!.getAttribute('data-mode')).toBe('plan');
        await d.create();
        await pickMode('default');
        await d.create();
        expect(d.created.map((c) => c.permissionMode)).toEqual([{ mode: 'plan', agentIds: ['forge'] }, undefined]);
    });

    it('where the machine does not allow it, bypass is not offered and the note links the machine page', async () => {
        const d = await open({ machines: [MAC, PC], lastMachineId: 'm_mac', agents: withAccounts });
        await d.pick('forge');
        expect(modeOptions()).not.toContain('bypassPermissions');
        expect(document.querySelector('[data-new-chat-permission]')!.getAttribute('data-mode')).toBe('default');
        expect(document.querySelector('[data-new-chat-permission-note] a')!.getAttribute('href')).toBe('/machines/m_mac');
        await d.create();
        expect(d.created[0]!.permissionMode).toBeUndefined();
    });
});
