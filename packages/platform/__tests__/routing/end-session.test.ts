/**
 * "New session" (#399; CHT-04, CHT-09, AGT-07, OPS-10): a chat member's
 * session ends when someone means it to — `Routing.endSession` from the
 * chat, or the member's removal — and nothing of it is left behind: the
 * record and every one of its pages are purged, the chat's binding drops,
 * the next message opens a fresh session that knows none of the old
 * conversation, and the chat's own history is untouched. An agent may not
 * call it. The same in-process host as `reuse.test.ts`, plus a
 * `WorkspaceStore` over the test storage and a Chat with the routing port.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actorKey, type AgentId, type ChatId, type EnvironmentId, type MachineId, type MessageId, type OfflinePolicy, type Principal, type PromptPart, type RuntimeId, type SessionId, type TaskContract, type TaskId, type WorkspaceId } from '@agentic/core';
import { inMemoryEnvironment, inMemoryHarness, type InMemoryDaemon, type PlatformSeat } from '@agentic/daemon-protocol/testing';
import { allowAll } from '@sigx/ai-agent';
import { mockAgent, type MockAgent } from '@sigx/ai-agent/testing';

import { AgentActor, agentKey } from '../../src/agent/index';
import { mintAgentPrincipal, workspaceKey } from '../../src/auth/index';
import { defineChatActor } from '../../src/chat/index';
import { defineMachineActor, machineKey, parseMachineKey, type MachineSocketPort } from '../../src/machine/index';
import { PairingDirectory } from '../../src/pairing/index';
import { createToolCallPort, defineRoutingActor, routingKey, SESSION_RESET_CODE } from '../../src/routing/index';
import { defineSessionActor, SESSION_PAGE_TYPE, SessionPage, sessionPageKey, type CommandSink, type SessionFactory } from '../../src/session/index';
import { TaskActor, taskKey, type TaskView } from '../../src/task/index';
import { Workspace, type ActorRecordRef, type WorkspaceStore } from '../../src/workspace/index';
import { statusOf, testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

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

const until = async (check: () => Promise<boolean> | boolean, what: string, timeoutMs = 8_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
};

/** About 700 KB streamed in 1 KB deltas: past `WINDOW_BYTES`, so the log rolls one page out of the record (#198). */
const BIG = 'y'.repeat(700_000);

/** The `anthropic-api` runtime: `big` streams a page's worth, `slow` works for a while first, anything else echoes. */
function scriptedAgent(): MockAgent {
    return mockAgent({
        respond: (input) => {
            const text = input.map((p) => (p.type === 'text' ? p.text : '')).join('');
            if (text.startsWith('big')) return [{ text: BIG, chunkSize: 1000 }];
            if (text.startsWith('slow')) return [{ tool: { name: 'slow', input: {}, output: 'done', delayMs: 1_500 } }, { text: 'after' }];
            return [{ text: `echo: ${text}` }];
        }
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
let purged: ActorRecordRef[];
let Session: ReturnType<typeof defineSessionActor>;
let Machine: ReturnType<typeof defineMachineActor>;
let Routing: ReturnType<typeof defineRoutingActor>;
let Chat: ReturnType<typeof defineChatActor>;
const daemons: InMemoryDaemon[] = [];

/** The app-level port over the test storage (the cascade test's): deactivate, then clear the record. */
const store: WorkspaceStore = {
    async purge(ref) {
        purged.push(ref);
        await app.host.deactivate(ref);
        const record = await app.storage.load(ref.type, ref.key);
        if (record) await app.storage.clear(ref.type, ref.key, record.etag);
    }
};

beforeEach(async () => {
    purged = [];
    sockets = new FakeSockets();
    const sink: CommandSink = { send: (t, cmd) => app.as(owner).actor(Machine, machineKey(t.workspaceId, t.machineId)).sendCommand(t.sessionId, cmd) };
    Session = defineSessionActor({ factory: localFactory(scriptedAgent()), commands: sink });
    Routing = defineRoutingActor({ sessions: () => Session, machines: () => Machine, store });
    Machine = defineMachineActor({ socket: sockets, sessions: () => Session, routing: () => Routing, tools: createToolCallPort({ routing: () => Routing, sessions: () => Session }) });
    // The Chat with the routing port (#399): a removal ends the member's session through the router.
    Chat = defineChatActor({ routing: () => Routing });
    app = testActorApp([Routing, Session, SessionPage, Machine, TaskActor, AgentActor, Workspace, PairingDirectory, Chat]);
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
const sessionKey = (id: string): string => actorKey(WS, 'session', id);
const chat = (id: ChatId) => app.as(owner).actor(Chat, actorKey(WS, 'chat', id));
const stored = (type: string, key: string) => app.storage.load(type, key);
const purgedKeys = (): string[] => purged.map((r) => `${r.type} ${r.key}`);

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

/** What `runActivation` does in the browser: post the message, create the task it activates for `assignee`, hand it to the router. */
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
        throw new Error(`${(e as Error).message}\n${JSON.stringify({ task: { status: t.status, wait: t.wait, sessionId: t.sessionId }, routes: r.routes }, null, 1)}`);
    }
};
const bound = (chatId: ChatId, agentId: AgentId, sid: string) => until(async () => (await chat(chatId).get()).sessions[agentId]?.sessionId === sid, `the binding of ${agentId} to ${sid}`);
const unbound = (chatId: ChatId, agentId: AgentId) => until(async () => (await chat(chatId).get()).sessions[agentId] === undefined, `the binding of ${agentId} to drop`);
const statuses = async (chatId: ChatId) => (await chat(chatId).history(null, 50)).entries.map((e) => e.entry).filter((e) => e.t === 'status').map((e) => e.kind);
const messages = async (chatId: ChatId) => (await chat(chatId).history(null, 50)).entries.map((e) => e.entry).filter((e) => e.t === 'msg');
const promptText = (input: readonly PromptPart[]): string => input.map((p) => (p.type === 'text' ? p.text : `<${p.type}>`)).join('\n');
/** The text of every prompt a local session's log holds, one string per turn, oldest first. */
const prompts = async (sessionId: string): Promise<string[]> => (await session(sessionId).events()).filter((e) => e.type === 'turn-start').map((e) => promptText((e as { input: readonly PromptPart[] }).input));
const frames = (machineId: MachineId, t: string) => sockets.frames(machineKey(WS, machineId)).filter((f) => f.t === t);
/** The text of every prompt the platform sent the daemon for `sessionId`, oldest first. */
const sentPrompts = (machineId: MachineId, sessionId: string): string[] =>
    frames(machineId, 'session.command')
        .filter((f) => f.sessionId === sessionId && (f.command as { type: string }).type === 'prompt')
        .map((f) => promptText((f.command as { input: PromptPart[] }).input));

describe('New session — anthropic-api', () => {
    it('ends the member’s session, purges its record and every page, and the next message opens a fresh one that knows none of it while the chat’s history stays', async () => {
        const atlas = await agent('agent_atlas', { runtime: 'anthropic-api' }, 'Atlas');
        const chatId = await room(atlas);
        const first = await message(chatId, atlas, 'big', 't1');
        await settled('t1');
        const sid = first.sessionId!;
        const key = sessionKey(sid);
        await bound(chatId, atlas, sid);
        await until(async () => ((await chat(chatId).get()).sessions[atlas]?.seenSeq ?? 0) > 0, "the member's answer to move the watermark");
        // The turn streamed past the window: the log holds at least one page beside the record.
        const pages = (await session(sid).get()).pages;
        expect(pages).toBeGreaterThanOrEqual(1);
        expect(await stored(Session.type, key)).not.toBeNull();
        for (let p = 0; p < pages; p++) expect(await stored(SESSION_PAGE_TYPE, sessionPageKey(key, p)), `page ${p}`).not.toBeNull();
        const historyBefore = (await messages(chatId)).length;
        expect(historyBefore).toBe(2);

        expect(await routing().endSession(chatId, atlas, 'the user asked for a new session')).toBe(sid);

        // The binding is gone — and so are the record and every one of its pages, pages first.
        await unbound(chatId, atlas);
        expect(purgedKeys()).toEqual([...Array.from({ length: pages }, (_, p) => `${SESSION_PAGE_TYPE} ${sessionPageKey(key, p)}`), `${Session.type} ${key}`]);
        expect(await stored(Session.type, key)).toBeNull();
        for (let p = 0; p < pages; p++) expect(await stored(SESSION_PAGE_TYPE, sessionPageKey(key, p)), `page ${p}`).toBeNull();
        expect((await session(sid).get()).opened).toBe(false);
        // The chat's own history is untouched: the message and the answer are still there.
        expect((await messages(chatId)).length).toBe(historyBefore);
        expect((await statuses(chatId)).filter((k) => k === 'session-ended')).toHaveLength(1);

        // The next message opens a fresh session: a new id, one turn in its log, the activation context again — nothing of the old conversation.
        const second = await message(chatId, atlas, 'what did I say?', 't2');
        await settled('t2');
        expect(second.sessionId).toBeDefined();
        expect(second.sessionId).not.toBe(sid);
        expect((await task('t2').get())).toMatchObject({ status: 'completed', result: { text: 'echo: what did I say?Chat so far:\nYou: what did I say?' } });
        expect(await prompts(second.sessionId!)).toEqual(['what did I say?\nChat so far:\nYou: what did I say?']);
        expect((await chat(chatId).get()).sessions[atlas]?.sessionId).toBe(second.sessionId);
        expect((await messages(chatId)).length).toBe(historyBefore + 2);
        // The old record stays gone: nothing re-created it.
        expect(await stored(Session.type, key)).toBeNull();
    });

    it('a reset mid-turn fails the task session-reset, stops the turn, and the member answers the next message in a fresh session', async () => {
        const atlas = await agent('agent_atlas', { runtime: 'anthropic-api' }, 'Atlas');
        const chatId = await room(atlas);
        const first = await message(chatId, atlas, 'slow', 't1');
        const sid = first.sessionId!;
        await until(async () => (await routing().get()).routes.some((r) => r.taskId === 't1' && r.status === 'running'), 'the turn to run');

        expect(await routing().endSession(chatId, atlas, 'the user asked for a new session')).toBe(sid);
        const t = await task('t1').get();
        expect(t.status).toBe('failed');
        expect(t.error).toMatchObject({ code: SESSION_RESET_CODE, recoverable: true });
        expect(t.error?.message).toContain(sid);
        expect((await routing().get()).routes).toEqual([]);
        // The chat heard a named failure where the answer would have been (OPS-04), and the binding is gone.
        await until(async () => (await statuses(chatId)).includes('task-failed'), 'the failure in the chat');
        await unbound(chatId, atlas);
        expect(await stored(Session.type, sessionKey(sid))).toBeNull();

        const second = await message(chatId, atlas, 'hello again', 't2');
        await settled('t2');
        expect(second.sessionId).not.toBe(sid);
        expect((await task('t2').get())).toMatchObject({ status: 'completed', result: { text: 'echo: hello againChat so far:\nYou: hello again' } });
    });

    it('removing the member from the chat ends its session through the chat’s routing port', async () => {
        const atlas = await agent('agent_atlas', { runtime: 'anthropic-api' }, 'Atlas');
        const chatId = await room(atlas);
        const first = await message(chatId, atlas, 'hello', 't1');
        await settled('t1');
        const sid = first.sessionId!;
        await bound(chatId, atlas, sid);
        expect((await session(sid).get()).status).not.toBe('closed');

        expect(await chat(chatId).removeAgent(atlas)).toBe(true);
        await until(async () => (await session(sid).get()).opened === false, 'the record to be purged');
        expect(purgedKeys()).toEqual([`${Session.type} ${sessionKey(sid)}`]);
        const summary = await chat(chatId).get();
        expect(summary.members).toEqual({});
        expect(summary.sessions).toEqual({});
        // The chat's history is untouched.
        expect((await messages(chatId)).length).toBe(2);
    });

    it('a member with no session answers null; an agent principal is refused; a session id that is not the member’s is refused — nothing changes', async () => {
        const atlas = await agent('agent_atlas', { runtime: 'anthropic-api' }, 'Atlas');
        const bob = await agent('agent_bob', { runtime: 'anthropic-api' }, 'Bob');
        const chatId = await room(atlas, bob);
        expect(await routing().endSession(chatId, bob, 'nothing to end')).toBeNull();
        const first = await message(chatId, atlas, 'hello', 't1');
        await settled('t1');
        const sid = first.sessionId!;
        await bound(chatId, atlas, sid);
        const other = await message(chatId, bob, 'hi bob', 't2');
        await settled('t2');
        const bobSid = other.sessionId!;
        await bound(chatId, bob, bobSid);

        // An agent must not wipe its own — or another member's — conversation.
        const asAtlas = mintAgentPrincipal({ workspaceId: WS, agentId: atlas, sessionId: sid as SessionId });
        expect(await statusOf(app.as(asAtlas).actor(Routing, routingKey(WS)).endSession(chatId, atlas, 'no'))).toBe(403);
        expect(await statusOf(app.as(asAtlas).actor(Routing, routingKey(WS)).endSession(chatId, bob, 'no'))).toBe(403);
        // A named session is never taken on trust: with the binding there it must be that one; without, the record must name this member and chat.
        expect(await statusOf(routing().endSession(chatId, atlas, 'no', bobSid as SessionId))).toBe(409);
        await chat(chatId).removeAgent(bob);
        await until(async () => (await session(bobSid).get()).opened === false, "bob's record to be purged by the removal");
        expect(await statusOf(routing().endSession(chatId, bob, 'no', sid as SessionId))).toBe(409);
        // A session that is already gone is nothing to end.
        expect(await routing().endSession(chatId, bob, 'again', bobSid as SessionId)).toBeNull();
        expect((await session(sid).get()).status).not.toBe('closed');
        expect((await chat(chatId).get()).sessions[atlas]?.sessionId).toBe(sid);
        expect(purgedKeys()).toEqual([`${Session.type} ${sessionKey(bobSid)}`]);
    });
});

describe('New session — daemon', () => {
    it('tells the daemon close, the machine frees the slot, the driver drops the binding itself, and the next message opens a fresh session on the machine', async () => {
        const m1 = await pairMachine('laptop');
        connect(m1, daemon(m1));
        await online(m1);
        const cc = await agent('agent_cc', { runtime: 'in-memory', defaultEnvironmentId: E1 });
        const chatId = await room(cc);
        const first = await message(chatId, cc, 'one', 't1');
        await settled('t1');
        const sid = first.sessionId!;
        await bound(chatId, cc, sid);
        expect((await machine(m1).get()).activeSessions.map((h) => h.sessionId)).toEqual([sid]);

        expect(await routing().endSession(chatId, cc, 'the user asked for a new session')).toBe(sid);
        // The daemon was told to close the session; its ack was still out when the record went, so the driver told the chat.
        expect(frames(m1, 'session.command').filter((f) => f.sessionId === sid && (f.command as { type: string }).type === 'close')).toHaveLength(1);
        await unbound(chatId, cc);
        expect((await statuses(chatId)).filter((k) => k === 'session-ended')).toHaveLength(1);
        expect(await stored(Session.type, sessionKey(sid))).toBeNull();
        expect(purgedKeys()).toEqual([`${Session.type} ${sessionKey(sid)}`]);
        await until(async () => (await machine(m1).get()).activeSessions.length === 0, 'the machine to free the slot');

        const second = await message(chatId, cc, 'two', 't2');
        await settled('t2');
        expect(second.sessionId).not.toBe(sid);
        expect((await task('t2').get()).status).toBe('completed');
        expect(frames(m1, 'session.open').map((f) => f.sessionId)).toEqual([sid, second.sessionId]);
        // The fresh session carries the whole activation context again — nothing of it has been seen.
        expect(sentPrompts(m1, second.sessionId!)).toEqual(['two\nChat so far:\nYou: two']);
        expect((await chat(chatId).get()).sessions[cc]?.sessionId).toBe(second.sessionId);
        // The old record stays gone: the daemon's late ack and `session.closed` re-created nothing.
        expect(await stored(Session.type, sessionKey(sid))).toBeNull();
    });
});
