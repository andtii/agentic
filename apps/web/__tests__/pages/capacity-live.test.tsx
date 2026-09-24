/**
 * A chat waiting on capacity says so (#652; EXE-09): a message parked for a free slot on its environment reads as a
 * notice under the thread — the environment, the machine, the turns running out of the limit — its member reads
 * QUEUED, and "Change limit" opens that environment's edit dialog on the machine page (`?env=`), where "Turns at once"
 * is the daemon's `concurrency`. A machine the web may not manage shows the command that changes it instead.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { actorKey, type AgentId, type ChatId, type EnvironmentDescriptor, type EnvironmentId, type MachineId, type MachinePolicy, type TaskId } from '@agentic/core';
import { DAEMON_PROTOCOL_VERSION } from '@agentic/daemon-protocol';
import { IN_MEMORY_CAPABILITIES, inMemoryEnvironment } from '@agentic/daemon-protocol/testing';
import { Chat, TaskActor, Workspace, defineMachineActor, machineKey, workspaceKey, type ChatSummary, type TaskIndexRow } from '@agentic/platform';
import { chatKeyOf } from '../../src/actors/keys';
import { capacityWaitText } from '../../src/components/status';
import { chatWaitsOf, membersOf, queuedAgents } from '../../src/pages/chat/live';
import { concurrencyCommand } from '../../src/pages/machines/manage';
import { liveCapacity, queuedByEnvironment } from '../../src/pages/machines/live';
import { machineHead } from '../../src/pages/machines/head';
import { USER, WS, mountLive, owner, startLive, tick, until, type LiveHarness } from './live-harness';

const row = (over: Omit<Partial<TaskIndexRow>, 'id'> & { id: string }): TaskIndexRow => ({ objective: 'x', assignee: 'a1' as AgentId, owner: 'a1' as AgentId, status: 'active', origin: 'user', depth: 0, createdAt: 0, updatedAt: 0, n: 1, ...over }) as never;
const capacity = (position: number) => ({ kind: 'capacity' as const, environmentId: 'env_work' as EnvironmentId, position });

describe('the model: which waits the chat says, who reads QUEUED, the wording', () => {
    const rows = [
        row({ id: 'root', chatId: 'c1' as ChatId, status: 'waiting', wait: { kind: 'child', childTaskIds: ['kid' as TaskId] } }),
        row({ id: 'kid', parentId: 'root' as TaskId, assignee: 'a2' as AgentId, status: 'waiting', wait: capacity(2) }),
        row({ id: 'first', chatId: 'c1' as ChatId, assignee: 'a3' as AgentId, status: 'waiting', wait: capacity(1) }),
        row({ id: 'other', chatId: 'c2' as ChatId, assignee: 'a4' as AgentId, status: 'waiting', wait: capacity(1) }),
        row({ id: 'off', chatId: 'c1' as ChatId, status: 'waiting', wait: { kind: 'machine-offline', machineId: 'm1' as MachineId, since: 5 } })
    ];

    it('finds the first in line of this chat’s tree, children included, and the offline wait — never another chat’s', () => {
        expect(chatWaitsOf(rows, 'c1')).toEqual({ offline: { kind: 'machine-offline', machineId: 'm1', since: 5 }, capacity: { taskId: 'first', agentId: 'a3', wait: capacity(1) } });
        expect(chatWaitsOf(rows, 'c2').capacity?.taskId).toBe('other');
        expect(chatWaitsOf(rows, 'c3')).toEqual({});
        expect([...queuedAgents(rows, 'c1')].sort()).toEqual(['a2', 'a3']);
    });

    it('a member whose message waits for a slot reads QUEUED, below WAITING and ACTIVE', () => {
        const summary = { members: { a1: { historyFrom: 0, since: 0 }, a2: { historyFrom: 0, since: 0 }, a3: { historyFrom: 0, since: 0 } } } as unknown as ChatSummary;
        const members = membersOf(summary, new Set(['a1']), new Set(['a2']), new Set(['a1', 'a2', 'a3']));
        expect(members.map((m) => [m.agentId, m.status])).toEqual([['a1', 'waiting'], ['a2', 'active'], ['a3', 'queued']]);
    });

    it('says where, how full, and the place in line', () => {
        expect(capacityWaitText(capacity(1), { environment: 'work', machine: 'alien01' }, { active: 1, max: 1 })).toBe('Waiting for a free slot on work (alien01): 1 of 1 turn running');
        expect(capacityWaitText(capacity(2), { environment: 'work' }, { active: 3, max: 3 })).toBe('Waiting for a free slot on work: 3 of 3 turns running · 2nd in line');
        expect(capacityWaitText(capacity(12), {})).toBe('Waiting for a free slot on env_work · 12th in line');
    });

    it('the machine pages count the turns running from the sessions, and slot waits as queued', () => {
        const d = { ...inMemoryEnvironment('m1' as MachineId, 'env_work' as EnvironmentId), concurrency: { max: 2, active: 0 } };
        const view = { environments: [d], activeSessions: [{ sessionId: 's1', environmentId: 'env_work', running: 't1' }, { sessionId: 's2', environmentId: 'env_work' }], pending: [] } as never;
        expect(liveCapacity(view)[0]!.concurrency).toEqual({ max: 2, active: 1 });
        const routing = { key: 'r', reports: {}, routes: [
            { taskId: 'a', status: 'waiting-capacity', environmentId: 'env_work', machineId: 'm1' },
            { taskId: 'b', status: 'waiting-offline', environmentId: 'env_work', machineId: 'm1' },
            { taskId: 'c', status: 'running', environmentId: 'env_work', machineId: 'm1' }
        ] } as never;
        expect(queuedByEnvironment(routing, 'm1')).toEqual({ env_work: 2 });
    });

    it('the command keeps every field of the environment and changes only the limit', () => {
        const d = { ...inMemoryEnvironment('m1' as MachineId, 'env_work' as EnvironmentId), name: 'work', runtime: 'claude-code', account: { label: 'client', authStatus: 'ok' as const }, cwdRoots: ['C:\\Dev', 'C:\\My Src'], allowBypassPermissions: true };
        expect(concurrencyCommand(d, 3)).toBe('agentic-daemon env add --id env_work --name work --runtime claude-code --root C:\\Dev --root "C:\\My Src" --account client --allow-bypass --concurrency 3 --replace');
        expect(concurrencyCommand({ ...d, account: { label: 'work', authStatus: 'ok' }, allowBypassPermissions: false }, 2)).not.toMatch(/--account|--allow-bypass/);
    });
});

// ---- live ------------------------------------------------------------------------------------------------------

type Frame = { t: string; requestId?: string; op?: string; environment?: Record<string, unknown> };

let h: LiveHarness;
let frames: Frame[] = [];
const Machine = defineMachineActor({ socket: { send: (_key, text) => { frames.push(JSON.parse(text) as Frame); return true; }, close: () => undefined } });

beforeEach(async () => {
    frames = [];
    h = await startLive(undefined, { actors: [Machine] });
});
afterEach(async () => {
    machineHead.value = null;
    await h.stop();
});

const V = DAEMON_PROTOCOL_VERSION;
const CLAUDE = { ...IN_MEMORY_CAPABILITIES, runtime: 'claude-code' };
const ON: MachinePolicy = { webManaged: true, allowedRoots: ['C:\\Dev'] };
const work = (machineId: MachineId): EnvironmentDescriptor => ({
    ...inMemoryEnvironment(machineId, 'env_work' as EnvironmentId),
    name: 'work',
    runtime: 'claude-code',
    account: { label: 'work', authStatus: 'ok' },
    cwdRoots: ['C:\\Dev'],
    concurrency: { max: 1, active: 0 },
    isolation: 'config-dir'
});

async function pairMachine(name: string, policy?: MachinePolicy) {
    const ws = h.app.as(owner).actor(Workspace, workspaceKey(WS));
    const { machineId, pairingCode } = await ws.registerMachinePending({ name });
    const daemon = h.app.as({ kind: 'machine', workspaceId: WS, machineId }).actor(Machine, machineKey(WS, machineId));
    await daemon.pair(pairingCode, { name, os: 'windows', daemonVersion: '0.1.0-test' });
    await daemon.socketMessage(JSON.stringify({ v: V, t: 'hello', machineId, daemonVersion: '0.1.0-test', os: 'windows', environments: [work(machineId)], capabilities: [CLAUDE], resume: {}, ...(policy ? { policy } : {}) }));
    return { machineId };
}

const popup = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-scope="dialog"][data-part="popup"][data-state="open"]');

describe('the chat page (live): the capacity notice, QUEUED, and the link to the limit', () => {
    it('shows while the message waits for a slot and clears when it runs', { timeout: 20_000 }, async () => {
        const { machineId } = await pairMachine('alien01', ON);
        const agentId = await h.agent('Atlas', 'Assistant');
        const { chatId } = await h.app.as(owner).actor(Workspace, workspaceKey(WS)).createChat({});
        const chat = h.app.as(owner).actor(Chat, chatKeyOf(USER, chatId));
        await chat.addAgent(agentId, 'all');
        const taskId = 't_slot' as TaskId;
        const task = h.app.as(owner).actor(TaskActor, actorKey(WS, 'task', taskId));
        await task.create({ objective: 'second chat', origin: { kind: 'user', chatId, messageId: 'msg_1' as never }, assignee: agentId, context: [], constraints: {} }, { owner: agentId });
        await task.reportWaiting(capacity(1), 'router');

        const dom = await mountLive(`/chats/${chatId}`, h);
        const notice = () => dom.querySelector<HTMLElement>('[data-chat-wait-capacity]');
        await until(() => notice()?.textContent?.startsWith('Waiting for a free slot on work (alien01): 0 of 1 turn running') === true, 'the capacity notice');
        expect(notice()!.getAttribute('role')).toBe('status');
        expect(notice()!.querySelector('a')?.getAttribute('href')).toBe(`/machines/${machineId}?env=env_work`);
        expect(notice()!.querySelector('a')?.textContent).toBe('Change limit');

        await task.resolveWaiting('router');
        await until(() => notice() === null, 'the notice to clear');
    });
});

describe('/machines/:id?env= — the limit a chat links to', () => {
    it('opens that environment’s edit dialog, and a new "Turns at once" goes to the daemon', { timeout: 15_000 }, async () => {
        const { machineId } = await pairMachine('alien01', ON);
        const dom = await mountLive(`/machines/${machineId}?env=env_work`, h);
        await until(() => popup() !== null, 'the edit dialog');
        const hidden = popup()!.querySelector<HTMLInputElement>('input[name="env-concurrency"]')!;
        expect(hidden.closest('[data-scope="field"]')?.textContent).toContain('Turns at once');
        expect(hidden.value).toBe('1');
        // The visible input: a draft while typing, committed on blur — as clicking Save does in a browser.
        const field = hidden.parentElement!.querySelector<HTMLInputElement>('[data-scope="number-input"][data-part="input"]')!;
        field.value = '3';
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new FocusEvent('blur'));
        await tick();
        expect(hidden.value).toBe('3');
        const save = [...popup()!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Save environment');
        save!.click();
        await until(() => frames.some((f) => f.t === 'env.request'), 'the env.request frame');
        expect(frames.find((f) => f.t === 'env.request')).toMatchObject({ op: 'put', environment: { id: 'env_work', concurrency: 3 } });
        expect(dom.querySelector('[data-env-limit]')).toBeNull();
    });

    it('with web management off, the card shows the command that changes the limit instead', { timeout: 15_000 }, async () => {
        const { machineId } = await pairMachine('alien01');
        const dom = await mountLive(`/machines/${machineId}?env=env_work`, h);
        await until(() => dom.querySelector('[data-env-limit]') !== null, 'the command');
        expect(dom.querySelector('[data-env-limit] code')?.textContent).toBe('agentic-daemon env add --id env_work --name work --runtime claude-code --root C:\\Dev --concurrency 2 --replace');
        expect(popup()).toBeNull();
        // Only the environment the link names.
        const plain = await mountLive(`/machines/${machineId}`, h);
        await tick();
        expect(plain.querySelector('[data-env-limit]')).toBeNull();
    });
});
