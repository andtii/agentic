/**
 * The update drain through the router (#365; EXE-09, EXE-11): while an update is pending a new task's session still
 * opens, but its prompt parks `waiting-capacity`; the `hello` on the new version ends the drain and the parked task
 * runs. The in-process host of `routing/capacity.test.ts` — Routing + Task + Agent + Session + Chat + Machine over an
 * in-memory daemon, which reports `IN_MEMORY_BUILD` and fakes the update's phases; the `hello` it would send as the new
 * build is the test's own.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actorKey, type AgentId, type ChatId, type EnvironmentId, type MachineId, type MessageId, type Principal, type PromptPart, type ReleaseManifest, type TaskId, type WorkspaceId } from '@agentic/core';
import { IN_MEMORY_BUILD, inMemoryEnvironment, inMemoryHarness, type InMemoryDaemon, type PlatformSeat } from '@agentic/daemon-protocol/testing';

import { AgentActor, agentKey } from '../../src/agent/index';
import { AuditActor, auditKey } from '../../src/audit/index';
import { Chat } from '../../src/chat/index';
import { workspaceKey } from '../../src/auth/index';
import { defineMachineActor, machineKey, type MachineSocketPort } from '../../src/machine/index';
import { PairingDirectory } from '../../src/pairing/index';
import { defineReleaseDirectory, RELEASE_DIRECTORY_KEY, RELEASE_SOURCES } from '../../src/releases/index';
import { defineRoutingActor, routingKey } from '../../src/routing/index';
import { defineSessionActor, type CommandSink } from '../../src/session/index';
import { TaskActor, taskKey, type TaskView } from '../../src/task/index';
import { Workspace } from '../../src/workspace/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const E1 = 'env_1' as EnvironmentId;
const asMachine = (id: MachineId): Principal => ({ kind: 'machine', workspaceId: WS, machineId: id });
const SHA = 'c'.repeat(64);
const release = (version: string, channel: 'stable' | 'latest'): ReleaseManifest => ({
    version,
    channel,
    publishedAt: 1_700_000_000_000,
    commit: 'abc1234',
    protocol: 1,
    assets: { 'linux-x64': { url: `https://example.test/${version}/agentic-daemon-linux-x64.zip`, sha256: SHA, bytes: 100, version } },
    harnesses: {}
});
const served: Record<string, ReleaseManifest> = { [RELEASE_SOURCES.stable]: release('0.2.0', 'stable'), [RELEASE_SOURCES.latest]: release('0.3.0-main.abc1234', 'latest') };
const Releases = defineReleaseDirectory({ fetch: (async (input: RequestInfo | URL) => new Response(JSON.stringify(served[String(input)]))) as typeof fetch });

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
    frames(key: string, t: string): Record<string, unknown>[] {
        return (this.sent.get(key) ?? []).map((s) => JSON.parse(s) as Record<string, unknown>).filter((f) => f.t === t);
    }
}

const until = async (check: () => Promise<boolean> | boolean, what: string, timeoutMs = 4_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
};

let app: TestActorApp;
let sockets: FakeSockets;
let Session: ReturnType<typeof defineSessionActor>;
let Machine: ReturnType<typeof defineMachineActor>;
let Routing: ReturnType<typeof defineRoutingActor>;
const daemons: InMemoryDaemon[] = [];
beforeEach(async () => {
    sockets = new FakeSockets();
    const sink: CommandSink = { send: (t, cmd) => app.as(owner).actor(Machine, machineKey(t.workspaceId, t.machineId)).sendCommand(t.sessionId, cmd) };
    Session = defineSessionActor({ factory: () => null, commands: sink });
    Routing = defineRoutingActor({ sessions: () => Session, machines: () => Machine });
    Machine = defineMachineActor({ socket: sockets, sessions: () => Session, routing: () => Routing, releases: () => Releases });
    app = testActorApp([Routing, Session, Machine, TaskActor, AgentActor, Workspace, PairingDirectory, Chat, Releases, AuditActor]);
    await app.start();
    await app.as(owner).actor(Releases, RELEASE_DIRECTORY_KEY).refresh();
});

afterEach(async () => {
    for (const d of daemons.splice(0)) d.stop();
    await app.stop();
});

const routing = () => app.as(owner).actor(Routing, routingKey(WS));
const task = (id: string) => app.as(owner).actor(TaskActor, taskKey(WS, id as TaskId));
const machine = (id: MachineId, principal: Principal = owner) => app.as(principal).actor(Machine, machineKey(WS, id));
const chat = (id: ChatId) => app.as(owner).actor(Chat, actorKey(WS, 'chat', id));

async function agent(id: string): Promise<AgentId> {
    const agentId = id as AgentId;
    await app.as(owner).actor(AgentActor, agentKey(WS, agentId)).update({ name: id, instructions: 'Be brief.', tools: [{ name: 'task_report' }], execution: { runtime: 'in-memory', defaultEnvironmentId: E1, offlinePolicy: 'fail' } }, 'create');
    return agentId;
}

async function message(chatId: ChatId, assignee: AgentId, text: string, id: string): Promise<TaskView> {
    const { messageId } = await chat(chatId).post(text, [assignee]);
    const context: PromptPart[] = [{ type: 'text', text: `Chat so far:\nYou: ${text}` }];
    await task(id).create({ objective: text, origin: { kind: 'user', chatId, messageId: messageId as MessageId }, assignee, context, constraints: {} }, { owner: assignee });
    return routing().run(id as TaskId);
}

/** Pair a machine and connect an in-memory daemon (its own `hello` reports `IN_MEMORY_BUILD` and the `update` feature); `hello(version)` is the daemon back on another build. */
async function pairMachine(): Promise<{ machineId: MachineId; hello: (version: string) => Promise<unknown> }> {
    const { machineId, pairingCode } = await app.as(owner).actor(Workspace, workspaceKey(WS)).registerMachinePending({ name: 'laptop' });
    await machine(machineId).pair(pairingCode, { name: 'laptop' });
    const environments = [{ ...inMemoryEnvironment(machineId, E1), concurrency: { max: 2, active: 0 } }];
    const d = inMemoryHarness({ machineId, environments }).start({ events: 3, heartbeatMs: 600_000 }) as InMemoryDaemon;
    daemons.push(d);
    const key = machineKey(WS, machineId);
    const seat = d.dial();
    sockets.seats.set(key, seat);
    sockets.connected.add(key);
    const asDaemon = machine(machineId, asMachine(machineId));
    void (async () => {
        try {
            for (;;) await asDaemon.socketMessage((await seat.next()) as string);
        } catch {
            // dropped
        }
    })();
    await until(async () => (await machine(machineId).get()).online, 'online');
    const hello = (version: string) =>
        asDaemon.socketMessage(
            JSON.stringify({ v: 1, t: 'hello', machineId, daemonVersion: version, os: 'linux', environments, capabilities: [], resume: {}, build: { ...IN_MEMORY_BUILD, version }, features: ['update', 'harness'] })
        );
    await until(async () => (await machine(machineId).updateState()).available?.version === '0.2.0', 'the release available');
    return { machineId, hello };
}

describe('the update drain through the router (#365)', () => {
    it('a task during the drain opens its session and waits capacity; the hello on the new version runs it', async () => {
        const { machineId, hello } = await pairMachine();
        const cc = await agent('agent_cc');
        const { chatId } = await app.as(owner).actor(Workspace, workspaceKey(WS)).createChat({ title: 'Room' });
        await chat(chatId).addAgent(cc, 'all');

        const { requestId } = await machine(machineId).requestUpdate();
        expect(sockets.frames(machineKey(WS, machineId), 'update.request')[0]).toMatchObject({ requestId, target: { version: '0.2.0', url: 'https://example.test/0.2.0/agentic-daemon-linux-x64.zip' } });
        // The fake stages the update and, with no turn running, restarts at once; the platform keeps draining until the next hello.
        await until(async () => (await machine(machineId).updateState()).pending?.phase === 'restarting', 'the update restarting');
        expect((await machine(machineId).updateState()).pending).toMatchObject({ from: IN_MEMORY_BUILD.version, target: '0.2.0' });

        const t = await message(chatId, cc, 'build it', 't_1');
        await until(async () => (await routing().get()).routes.find((r) => r.taskId === 't_1')?.status === 'waiting-capacity', 'the route parked on capacity');
        expect((await task('t_1').get()).wait).toMatchObject({ kind: 'capacity', environmentId: E1 });
        // The session opened (a drain holds back turns, not opens); no prompt went out.
        await until(async () => (await machine(machineId).get()).activeSessions.some((h) => h.sessionId === t.sessionId && h.status === 'open'), 'the session open');
        expect(sockets.frames(machineKey(WS, machineId), 'session.command').filter((f) => (f.command as { type: string }).type === 'prompt')).toEqual([]);

        // The daemon comes back on 0.2.0: the drain ends, the parked prompt goes out and the task completes.
        await hello('0.2.0');
        await until(async () => (await task('t_1').get()).status === 'completed', 'the task to complete');
        expect((await machine(machineId).updateState()).last).toMatchObject({ requestId, outcome: 'applied', to: '0.2.0' });
        await until(async () => (await app.as(owner).actor(AuditActor, auditKey(WS)).list({ kinds: ['machine.updated'] })).events.length === 1, 'machine.updated');
    });
});
