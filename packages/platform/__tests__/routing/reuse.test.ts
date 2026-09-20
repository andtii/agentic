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

describe('one live session per (chat, agent) — anthropic-api', () => {
    it('two messages to one member run in one session: one id, one session-started, two turns in one log, and the second prompt carries the unseen entries instead of the chat so far', async () => {
        const atlas = await agent('agent_atlas', { runtime: 'anthropic-api' }, 'Atlas');
        const chatId = await room(atlas);
        const first = await message(chatId, atlas, 'hello there', 't1');
        await settled('t1');
        const sid = first.sessionId!;
        expect((await task('t1').get()).result?.text).toBe('echo: hello thereChat so far:\nYou: hello there');
        // The chat bound the member to the session and saw its answer.
        await until(async () => ((await chat(chatId).get()).sessions[atlas]?.seenSeq ?? 0) > 0, "the member's answer to move the watermark");
        expect((await chat(chatId).get()).sessions[atlas]).toMatchObject({ sessionId: sid });
        // The session is live after the task settled, not closed.
        expect((await session(sid).get()).status).not.toBe('closed');
        expect((await routing().get()).routes).toEqual([]);

        // Something said meanwhile that the engine has not seen, then the next message to the member.
        await chat(chatId).post('by the way, blue', []);
        const second = await message(chatId, atlas, 'what did I say?', 't2');
        await settled('t2');
        expect(second.sessionId).toBe(sid);
        expect((await task('t2').get())).toMatchObject({ status: 'completed', sessionId: sid });
        // Two turns in the one log; the second prompt: the objective and what was said since — never the pre-rendered chat.
        const turns = await prompts(sid);
        expect(turns).toHaveLength(2);
        expect(turns[1]).toBe('what did I say?\nIn the chat since your last message:\nUser: by the way, blue');
        expect(turns[1]).not.toContain('Chat so far');
        expect((await task('t2').get()).result?.text).toBe('echo: what did I say?In the chat since your last message:\nUser: by the way, blue');
        // The second turn ran under its own task (#390), in the record's refreshed spec.
        const info = await session(sid).get();
        expect(info.status).not.toBe('closed');
        expect(info.spec).toMatchObject({ taskId: 't2', objective: 'what did I say?' });
        // The thread: the member started its session once and never ended it.
        expect((await statuses(chatId)).filter((k) => k === 'session-started')).toHaveLength(1);
        expect(await statuses(chatId)).not.toContain('session-ended');
        expect((await chat(chatId).get()).sessions[atlas]?.sessionId).toBe(sid);
    });

    it('the catch-up names every author, holds only what came after the member’s own answer, and leaves the triggering message out', async () => {
        const atlas = await agent('agent_atlas', { runtime: 'anthropic-api' }, 'Atlas');
        const bob = await agent('agent_bob', { runtime: 'anthropic-api' }, 'Bob');
        const chatId = await room(atlas, bob);
        await chat(chatId).post('first word', []);
        const first = await message(chatId, atlas, 'go', 't1');
        await settled('t1');
        const sid = first.sessionId!;
        await until(async () => ((await chat(chatId).get()).sessions[atlas]?.seenSeq ?? 0) > 0, 'the watermark');
        await chat(chatId).post('what bob says', []);
        const second = await message(chatId, atlas, 'again', 't2');
        await settled('t2');
        expect(second.sessionId).toBe(sid);
        const turns = await prompts(sid);
        // Only what came after the member's own answer: the user's later message, not the history its first prompt carried.
        expect(turns[1]).toBe('again\nIn the chat since your last message:\nUser: what bob says');
        // Another member's answer is attributed by name.
        await message(chatId, bob, 'bob, hi', 't3');
        await settled('t3');
        await until(async () => (await messages(chatId)).some((m) => m.author.kind === 'agent' && m.author.agentId === bob), "bob's answer in the chat");
        await message(chatId, atlas, 'and now?', 't4');
        await settled('t4');
        const last = (await prompts(sid))[2]!;
        expect(last).toContain('In the chat since your last message:');
        expect(last).toContain('User: bob, hi');
        expect(last).toContain('Bob: echo: bob, hi');
        expect(last).not.toContain('Atlas (you)');
    });
});

describe('one live session per (chat, agent) — daemon', () => {
    it('a coordinator staffing a member leaves two live sessions on the machine; a chatless task still opens and closes its own', async () => {
        const m1 = await pairMachine('laptop');
        connect(m1, daemon(m1));
        await online(m1);
        const cc = await agent('agent_cc', { runtime: 'in-memory', defaultEnvironmentId: E1 });
        const dev = await agent('agent_dev', { runtime: 'in-memory', defaultEnvironmentId: E1 });
        const chatId = await room(cc, dev);
        await chat(chatId).setCoordinator(cc);
        const a = await message(chatId, cc, 'plan it', 't_cc');
        const b = await message(chatId, dev, 'build it', 't_dev');
        await settled('t_cc');
        await settled('t_dev');
        expect(a.sessionId).not.toBe(b.sessionId);
        for (const sid of [a.sessionId!, b.sessionId!]) expect((await session(sid).get()).status).not.toBe('closed');
        expect((await machine(m1).get()).activeSessions.map((h) => h.sessionId).sort()).toEqual([a.sessionId, b.sessionId].sort());
        expect(Object.keys((await chat(chatId).get()).sessions).sort()).toEqual([cc, dev].sort());
        expect(frames(m1, 'session.command').filter((f) => (f.command as { type: string }).type === 'close')).toHaveLength(0);

        // Work from outside any chat: one throwaway session, closed at the turn's end (EXE-09).
        await task('t_ext').create({ objective: 'do the thing', origin: { kind: 'external', clientId: 'c1' }, assignee: cc, context: [], constraints: {} }, { owner: cc });
        const ext = await routing().run('t_ext' as TaskId);
        await settled('t_ext');
        expect(ext.sessionId).not.toBe(a.sessionId);
        await until(async () => (await session(ext.sessionId!).get()).status === 'closed', 'the chatless session to close');
        expect((await machine(m1).get()).activeSessions.map((h) => h.sessionId).sort()).toEqual([a.sessionId, b.sessionId].sort());
    });

    it('a second message reuses the hosted session with no second session.open; a moved folder ends it and a fresh one takes its place (EXE-12)', async () => {
        const m1 = await pairMachine('laptop');
        connect(m1, daemon(m1));
        await online(m1);
        const cc = await agent('agent_cc', { runtime: 'in-memory', defaultEnvironmentId: E1 });
        const chatId = await room(cc);
        const first = await message(chatId, cc, 'one', 't1', { environmentId: E1, workdir: '/work/a' });
        await settled('t1');
        const sid = first.sessionId!;
        await until(async () => (await chat(chatId).get()).sessions[cc]?.sessionId === sid, 'the binding');
        const ref = (await session(sid).get()).ref;
        expect(ref).toEqual({ agent: 'in-memory', v: 1, id: `${sid}.run` });

        const second = await message(chatId, cc, 'two', 't2', { environmentId: E1, workdir: '/work/a' });
        await settled('t2');
        expect(second.sessionId).toBe(sid);
        expect((await task('t2').get()).status).toBe('completed');
        // One open on the daemon, two prompts; the record was re-opened for the second task and keeps the runtime's ref.
        expect(frames(m1, 'session.open')).toHaveLength(1);
        expect((await session(sid).get()).spec).toMatchObject({ taskId: 't2', machineId: m1, cwd: '/work/a' });
        expect((await session(sid).get()).ref).toEqual(ref);
        // The in-memory daemon answers with no text, so the member's watermark never moved (`seenSeq` 0): the second
        // prompt carries everything from its `historyFrom` but the triggering message — never the pre-rendered chat.
        expect(sentPrompts(m1, sid)).toEqual(['one\nChat so far:\nYou: one', 'two\nIn the chat since your last message:\nUser: one']);

        // The member's folder moved: never migrated — the old session is ended, a fresh one opens in the new folder.
        const third = await message(chatId, cc, 'three', 't3', { environmentId: E1, workdir: '/work/b' });
        await settled('t3');
        expect(third.sessionId).not.toBe(sid);
        await until(async () => (await session(sid).get()).status === 'closed', 'the old session to close');
        expect((await session(third.sessionId!).get()).spec).toMatchObject({ cwd: '/work/b' });
        expect(frames(m1, 'session.open')).toHaveLength(2);
        // The old session was ended through its record — a `close` command to the daemon, which freed the slot.
        expect(frames(m1, 'session.command').filter((f) => f.sessionId === sid && (f.command as { type: string }).type === 'close')).toHaveLength(1);
        expect((await machine(m1).get()).activeSessions.map((h) => h.sessionId)).toEqual([third.sessionId]);
        // The fresh session carries the whole activation context again — nothing of it has been seen.
        expect(sentPrompts(m1, third.sessionId!)).toEqual(['three\nChat so far:\nYou: three']);
        expect((await chat(chatId).get()).sessions[cc]?.sessionId).toBe(third.sessionId);
        const kinds = await statuses(chatId);
        expect(kinds.filter((k) => k === 'session-started')).toHaveLength(2);
        expect(kinds.filter((k) => k === 'session-ended')).toHaveLength(1);
    });

    it('after the daemon restarts, the next message re-opens the same session with the recorded ref as resume', async () => {
        const m1 = await pairMachine('laptop');
        const d1 = daemon(m1);
        connect(m1, d1);
        await online(m1);
        const cc = await agent('agent_cc', { runtime: 'in-memory', defaultEnvironmentId: E1 });
        const chatId = await room(cc);
        const first = await message(chatId, cc, 'one', 't1');
        await settled('t1');
        const sid = first.sessionId!;
        const ref = (await session(sid).get()).ref!;
        expect(ref).toEqual({ agent: 'in-memory', v: 1, id: `${sid}.run` });

        // The daemon goes away and comes back empty: it no longer runs the session, and says so for the one the platform wanted.
        d1.stop();
        await online(m1, false);
        connect(m1, daemon(m1));
        await online(m1);
        expect(await machine(m1, asMachine(m1)).socketMessage(JSON.stringify({ v: 1, t: 'session.closed', sessionId: sid, reason: 'restarted' }))).toMatchObject({ ok: true });
        await until(async () => (await machine(m1).get()).activeSessions.length === 0, 'the machine to forget the session');
        // The record is untouched by that: not closed, still bound, its ref the runtime's.
        expect((await session(sid).get()).status).not.toBe('closed');
        expect((await chat(chatId).get()).sessions[cc]?.sessionId).toBe(sid);

        const second = await message(chatId, cc, 'two', 't2');
        expect(second.sessionId).toBe(sid);
        await until(() => frames(m1, 'session.open').length === 2, 'the re-open on the new daemon');
        const reopened = frames(m1, 'session.open')[1] as { sessionId: string; spec: { resume?: unknown; cwd: string } };
        expect(reopened.sessionId).toBe(sid);
        expect(reopened.spec.resume).toEqual(ref);
        expect((await session(sid).get())).toMatchObject({ status: 'idle', ref, spec: { taskId: 't2', machineId: m1 } });
        expect((await statuses(chatId)).filter((k) => k === 'session-started')).toHaveLength(1);
    });
});
