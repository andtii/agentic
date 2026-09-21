/**
 * One live session per (chat, agent) — the router reuses it and stops
 * closing it at turn end (#393; CHT-01, CHT-07, CHT-09, CHT-11, EXE-12,
 * EXE-13, MEM-07). The same in-process host as `routing.test.ts`: Routing +
 * Task + Agent + Session + Chat + Machine with an in-memory daemon, and a
 * `mockAgent` as the `anthropic-api` runtime. Offline and deterministic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actorKey, type AgentId, type ChatId, type EnvironmentId, type MachineId, type MessageId, type OfflinePolicy, type Principal, type PromptPart, type RuntimeId, type TaskContract, type TaskId, type WorkspaceId } from '@agentic/core';
import { inMemoryEnvironment, inMemoryHarness, type InMemoryDaemon, type PlatformSeat } from '@agentic/daemon-protocol/testing';
import { allowAll } from '@sigx/ai-agent';
import { mockAgent, type MockAgent } from '@sigx/ai-agent/testing';

import { AgentActor, agentKey } from '../../src/agent/index';
import { Chat } from '../../src/chat/index';
import { workspaceKey } from '../../src/auth/index';
import { defineMachineActor, machineKey, parseMachineKey, type MachineSocketPort } from '../../src/machine/index';
import { PairingDirectory } from '../../src/pairing/index';
import { createToolCallPort, defineRoutingActor, routingKey } from '../../src/routing/index';
import { defineSessionActor, type CommandSink, type SessionFactory } from '../../src/session/index';
import { TaskActor, taskKey, type TaskView } from '../../src/task/index';
import { Workspace } from '../../src/workspace/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const E1 = 'env_1' as EnvironmentId;
const asMachine = (id: MachineId): Principal => ({ kind: 'machine', workspaceId: WS, machineId: id });

/** A fake socket layer bridged to `InMemoryDaemon` seats (the routing test's). */
class FakeSockets implements MachineSocketPort {
    readonly seats = new Map<string, PlatformSeat>();
    readonly sent = new Map<string, string[]>();
    connected = new Set<string>();
    send(key: string, text: string): boolean {
        if (!this.connected.has(key)) return false;
        (this.sent.get(key) ?? this.sent.set(key, []).get(key)!).push(text);
        this.seats.get(key)?.send(JSON.parse(text));
        return true;
    }
    close(key: string): void {
        this.seats.get(key)?.drop();
        this.seats.delete(key);
        this.connected.delete(key);
    }
    frames(key: string): Record<string, unknown>[] {
        return (this.sent.get(key) ?? []).map((t) => JSON.parse(t) as Record<string, unknown>);
    }
}

const until = async (check: () => Promise<boolean> | boolean, what: string, timeoutMs = 4_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
};

/** The `anthropic-api` runtime: echoes the prompt's text parts. */
function scriptedAgent(): MockAgent {
    return mockAgent({
        respond: (input) => [{ text: `echo: ${input.map((p) => (p.type === 'text' ? p.text : '')).join('')}` }]
    });
}

function localFactory(agent: MockAgent): SessionFactory {
    return async (runtime, c) => {
        if (runtime !== 'anthropic-api') return null;
        const session = await agent.session({ policy: allowAll, signal: c.signal, ...(c.resume ? { resume: c.resume } : {}) });
        return { session, agentId: agent.id, capabilities: agent.capabilities };
    };
}

let app: TestActorApp;
let sockets: FakeSockets;
let Session: ReturnType<typeof defineSessionActor>;
let Machine: ReturnType<typeof defineMachineActor>;
let Routing: ReturnType<typeof defineRoutingActor>;
const daemons: InMemoryDaemon[] = [];
beforeEach(async () => {
    sockets = new FakeSockets();
    const sink: CommandSink = { send: (t, cmd) => app.as(owner).actor(Machine, machineKey(t.workspaceId, t.machineId)).sendCommand(t.sessionId, cmd) };
    Session = defineSessionActor({ factory: localFactory(scriptedAgent()), commands: sink });
    Routing = defineRoutingActor({ sessions: () => Session, machines: () => Machine });
    Machine = defineMachineActor({ socket: sockets, sessions: () => Session, routing: () => Routing, tools: createToolCallPort({ routing: () => Routing, sessions: () => Session }) });
    app = testActorApp([Routing, Session, Machine, TaskActor, AgentActor, Workspace, PairingDirectory, Chat]);
    await app.start();
});

afterEach(async () => {
    for (const d of daemons.splice(0)) d.stop();
    await app.stop();
});

const routing = () => app.as(owner).actor(Routing, routingKey(WS));
const task = (id: string) => app.as(owner).actor(TaskActor, taskKey(WS, id as TaskId));
const machine = (id: MachineId, principal: Principal = owner) => app.as(principal).actor(Machine, machineKey(WS, id));
const session = (id: string) => app.as(owner).actor(Session, actorKey(WS, 'session', id));
const chat = (id: ChatId) => app.as(owner).actor(Chat, actorKey(WS, 'chat', id));

async function agent(id: string, execution: { runtime: RuntimeId; defaultEnvironmentId?: EnvironmentId; offlinePolicy?: OfflinePolicy }, name = id): Promise<AgentId> {
    const agentId = id as AgentId;
    await app.as(owner).actor(AgentActor, agentKey(WS, agentId)).update({ name, instructions: 'Be brief.', tools: [{ name: 'task_report' }], execution: { offlinePolicy: 'fail', ...execution } }, 'create');
    return agentId;
}

/** A chat with `members` in it (every one reads all history). */
async function room(...members: AgentId[]): Promise<ChatId> {
    const { chatId } = await app.as(owner).actor(Workspace, workspaceKey(WS)).createChat({ title: 'Room' });
    for (const m of members) await chat(chatId).addAgent(m, 'all');
    return chatId;
}

/**
 * What `runActivation` does in the browser: post the message, create the task it activates for `assignee` (its
 * context the pre-rendered "Chat so far" block), hand it to the router.
 */
async function message(chatId: ChatId, assignee: AgentId, text: string, id: string, extra: Partial<TaskContract> = {}): Promise<TaskView> {
    const { messageId } = await chat(chatId).post(text, [assignee]);
    const context: PromptPart[] = [{ type: 'text', text: `Chat so far:\nYou: ${text}` }];
    await task(id).create({ objective: text, origin: { kind: 'user', chatId, messageId: messageId as MessageId }, assignee, context, constraints: {}, ...extra }, { owner: assignee });
    return routing().run(id as TaskId);
}

/** Register + pair a machine in the workspace, and connect its daemon. */
async function pairMachine(name: string): Promise<MachineId> {
    const { machineId, pairingCode } = await app.as(owner).actor(Workspace, workspaceKey(WS)).registerMachinePending({ name });
    await machine(machineId).pair(pairingCode, { name });
    return machineId;
}

function daemon(machineId: MachineId, environments = [inMemoryEnvironment(machineId, E1)]): InMemoryDaemon {
    const d = inMemoryHarness({ machineId, environments }).start({ events: 3, heartbeatMs: 600_000 }) as InMemoryDaemon;
    daemons.push(d);
    return d;
}

function connect(machineId: MachineId, d: InMemoryDaemon): PlatformSeat {
    const key = machineKey(WS, machineId);
    const ids = parseMachineKey(key)!;
    const seat = d.dial();
    sockets.seats.set(key, seat);
    sockets.connected.add(key);
    const asDaemon = machine(ids.machineId, asMachine(ids.machineId));
    void (async () => {
        try {
            for (;;) await asDaemon.socketMessage((await seat.next()) as string);
        } catch {
            // dropped
        }
        if (sockets.seats.get(key) === seat) {
            sockets.seats.delete(key);
            sockets.connected.delete(key);
            await asDaemon.socketClosed().catch(() => {});
        }
    })();
    return seat;
}

const online = (id: MachineId, is = true) => until(async () => (await machine(id).get()).online === is, `${id} ${is ? 'online' : 'offline'}`);
const settled = async (id: string) => {
    try {
        await until(async () => ['completed', 'failed', 'cancelled'].includes((await task(id).get()).status), `task ${id} to settle`);
    } catch (e) {
        const t = await task(id).get();
        const r = await routing().get();
        throw new Error(`${(e as Error).message}\n${JSON.stringify({ task: { status: t.status, wait: t.wait, sessionId: t.sessionId }, routes: r.routes, session: t.sessionId ? await session(t.sessionId).get() : undefined }, null, 1)}`);
    }
};
const statuses = async (chatId: ChatId) => (await chat(chatId).history(null, 50)).entries.map((e) => e.entry).filter((e) => e.t === 'status').map((e) => e.kind);
const messages = async (chatId: ChatId) => (await chat(chatId).history(null, 50)).entries.map((e) => e.entry).filter((e) => e.t === 'msg');
const promptText = (input: readonly PromptPart[]): string => input.map((p) => (p.type === 'text' ? p.text : `<${p.type}>`)).join('\n');
/** The text of every prompt a local session's log holds, one string per turn, oldest first. */
const prompts = async (sessionId: string): Promise<string[]> => (await session(sessionId).events()).filter((e) => e.type === 'turn-start').map((e) => promptText((e as { input: readonly PromptPart[] }).input));
const frames = (machineId: MachineId, t: string) => sockets.frames(machineKey(WS, machineId)).filter((f) => f.t === t);
/** The text of every prompt the platform sent the daemon for `sessionId`, oldest first (the in-memory daemon logs no `turn-start`). */
const sentPrompts = (machineId: MachineId, sessionId: string): string[] =>
    frames(machineId, 'session.command')
        .filter((f) => f.sessionId === sessionId && (f.command as { type: string }).type === 'prompt')
        .map((f) => promptText((f.command as { input: PromptPart[] }).input));

const configures = (machineId: MachineId, sessionId: string) =>
    frames(machineId, 'session.command')
        .filter((f) => f.sessionId === sessionId && (f.command as { type: string }).type === 'configure')
        .map((f) => (f.command as { patch: Record<string, string> }).patch);
const opened = (machineId: MachineId) => frames(machineId, 'session.open').map((f) => f.spec as { model?: string; permissionMode?: string });

describe('member session options (#453)', () => {
    it('Chat.setOptions folds onto the member, writes a note, clears with null and is idempotent', async () => {
        const cc = await agent('agent_cc', { runtime: 'in-memory', defaultEnvironmentId: E1 });
        const chatId = await room(cc);
        expect(await chat(chatId).setOptions(cc, { model: 'claude-fable-5-1', permissionMode: 'plan' })).toMatchObject({ options: { model: 'claude-fable-5-1', permissionMode: 'plan' } });
        const notes = (await messages(chatId)).filter((m) => m.options);
        expect(notes).toHaveLength(1);
        expect(notes[0]!.options).toEqual({ agentId: cc, patch: { model: 'claude-fable-5-1', permissionMode: 'plan' } });
        expect(notes[0]!.mentions).toEqual([]);
        // Nothing changed: nothing written.
        await chat(chatId).setOptions(cc, { model: 'claude-fable-5-1' });
        expect((await messages(chatId)).filter((m) => m.options)).toHaveLength(1);
        expect(await chat(chatId).setOptions(cc, { model: null })).toMatchObject({ options: { permissionMode: 'plan' } });
        expect((await chat(chatId).get()).members[cc]!.options).toEqual({ permissionMode: 'plan' });
        await chat(chatId).setOptions(cc, { permissionMode: null });
        expect((await chat(chatId).get()).members[cc]!.options).toBeUndefined();
        await expect(chat(chatId).setOptions('agent_nobody' as AgentId, { model: 'x' })).rejects.toThrow(/not a member/);
        await expect(chat(chatId).setOptions(cc, { effort: 'high' } as never)).rejects.toThrow(/unknown option effort/);
    });

    it('a fresh session opens with the member’s options; a change applies before the next prompt, as a configure on the same session', async () => {
        const m1 = await pairMachine('laptop');
        connect(m1, daemon(m1));
        await online(m1);
        const cc = await agent('agent_cc', { runtime: 'in-memory', defaultEnvironmentId: E1 });
        const chatId = await room(cc);
        await chat(chatId).setOptions(cc, { model: 'claude-sonnet-5', permissionMode: 'plan' });
        const first = await message(chatId, cc, 'one', 't1');
        await settled('t1');
        const sid = first.sessionId!;
        expect(opened(m1)).toEqual([expect.objectContaining({ model: 'claude-sonnet-5', permissionMode: 'plan' })]);
        expect((await session(sid).get()).options).toEqual({ model: 'claude-sonnet-5', permissionMode: 'plan' });
        expect(configures(m1, sid)).toEqual([]);

        await chat(chatId).setOptions(cc, { model: 'claude-fable-5-1', permissionMode: 'acceptEdits' });
        const second = await message(chatId, cc, 'two', 't2');
        await settled('t2');
        // The same session, configured before its prompt — never reopened for it.
        expect(second.sessionId).toBe(sid);
        expect(frames(m1, 'session.open')).toHaveLength(1);
        expect(configures(m1, sid)).toEqual([{ model: 'claude-fable-5-1', permissionMode: 'acceptEdits' }]);
        const commands = frames(m1, 'session.command').filter((f) => f.sessionId === sid).map((f) => (f.command as { type: string }).type);
        expect(commands).toEqual(['prompt', 'configure', 'prompt']);
        await until(async () => (await session(sid).get()).options?.model === 'claude-fable-5-1', 'the session to record its options');
        expect((await session(sid).get()).options).toEqual({ model: 'claude-fable-5-1', permissionMode: 'acceptEdits' });

        // Nothing changed since: the third turn is a prompt alone.
        await message(chatId, cc, 'three', 't3');
        await settled('t3');
        expect(configures(m1, sid)).toHaveLength(1);
    });

    it('bypassPermissions fails the task by name where the environment does not allow it, and opens where it does (EXE-12)', async () => {
        const m1 = await pairMachine('laptop');
        connect(m1, daemon(m1, [inMemoryEnvironment(m1, E1), { ...inMemoryEnvironment(m1, 'env_2' as EnvironmentId), allowBypassPermissions: true }]));
        await online(m1);
        const cc = await agent('agent_cc', { runtime: 'in-memory', defaultEnvironmentId: E1 });
        const free = await agent('agent_free', { runtime: 'in-memory', defaultEnvironmentId: 'env_2' as EnvironmentId });
        const chatId = await room(cc, free);
        await chat(chatId).setOptions(cc, { permissionMode: 'bypassPermissions' });
        await chat(chatId).setOptions(free, { permissionMode: 'bypassPermissions' });
        await message(chatId, cc, 'go', 't1');
        await settled('t1');
        expect((await task('t1').get())).toMatchObject({ status: 'failed', error: { code: 'permission-mode-not-allowed', recoverable: true } });
        expect(frames(m1, 'session.open')).toHaveLength(0);
        await message(chatId, free, 'go', 't2');
        await settled('t2');
        expect((await task('t2').get()).status).toBe('completed');
        expect(opened(m1)).toEqual([expect.objectContaining({ permissionMode: 'bypassPermissions' })]);
    });
});
