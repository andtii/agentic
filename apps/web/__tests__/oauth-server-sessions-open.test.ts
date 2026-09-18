/**
 * MCP `sessions_open` with a `cwd` (#190, bug): the port bound to the real
 * actors — Routing, Session, Machine over an in-memory daemon — must run the
 * session IN that folder (`OpenSpec.cwd`, the Session record's `spec.cwd`),
 * not in the environment's first root with the path as prompt text, and must
 * refuse a sibling that merely shares the root's prefix (`C:/src2` for root
 * `C:/src`) the way `pathWithin` does on the machine's OS.
 */
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentId, EnvironmentId, MachineId, Principal, WorkspaceId } from '@agentic/core';
import { inMemoryEnvironment, inMemoryHarness, type InMemoryDaemon, type PlatformSeat } from '@agentic/daemon-protocol/testing';
import type { ExternalPrincipal } from '@agentic/mcp';
import {
    AgentActor,
    Chat,
    Memory,
    PairingDirectory,
    TaskActor,
    Workspace,
    agentKey,
    defineMachineActor,
    defineRoutingActor,
    defineScheduleActor,
    defineSessionActor,
    machineKey,
    taskKey,
    workspaceKey,
    type CommandSink,
    type MachineSocketPort
} from '@agentic/platform';
import type { AnyActorDefinition } from '@sigx/actors';
import { statusOf, testActorApp, userPrincipal, type TestActorApp } from '../../../packages/platform/src/testing/index';
import { createActorPlatformPort } from '../src/auth/oauth-server/port';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const E1 = 'env_1' as EnvironmentId;
const ROOT = 'C:/src';
const asMachine = (id: MachineId): Principal => ({ kind: 'machine', workspaceId: WS, machineId: id });
const client: ExternalPrincipal = { kind: 'external', workspaceId: WS, clientId: 'cc', scopes: ['machines', 'environments', 'agents', 'sessions', 'tasks'] };

/** Sockets bridged to in-memory daemon seats; the daemon says it runs Windows, so paths follow Windows rules. */
class FakeSockets implements MachineSocketPort {
    readonly seats = new Map<string, PlatformSeat>();
    readonly sent = new Map<string, string[]>();
    send(key: string, text: string): boolean {
        const seat = this.seats.get(key);
        if (!seat) return false;
        (this.sent.get(key) ?? this.sent.set(key, []).get(key)!).push(text);
        seat.send(JSON.parse(text));
        return true;
    }
    close(key: string): void {
        this.seats.get(key)?.drop();
        this.seats.delete(key);
    }
    frames(key: string): { t: string; spec?: { cwd?: string } }[] {
        return (this.sent.get(key) ?? []).map((t) => JSON.parse(t) as { t: string });
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
let actors: readonly AnyActorDefinition[];
let Session: ReturnType<typeof defineSessionActor>;
let Machine: ReturnType<typeof defineMachineActor>;
const daemons: InMemoryDaemon[] = [];
beforeEach(async () => {
    sockets = new FakeSockets();
    const sink: CommandSink = { send: (t, cmd) => app.as(owner).actor(Machine, machineKey(t.workspaceId, t.machineId)).sendCommand(t.sessionId, cmd) };
    Session = defineSessionActor({ factory: () => null, commands: sink });
    const Routing = defineRoutingActor({ sessions: () => Session, machines: () => Machine });
    Machine = defineMachineActor({ socket: sockets, sessions: () => Session, routing: () => Routing });
    const Schedule = defineScheduleActor({ trigger: { fired: async () => {} } });
    actors = [Workspace, AgentActor, Chat, TaskActor, Session, Machine, Routing, Schedule, Memory, PairingDirectory];
    app = testActorApp(actors);
    await app.start();
});
afterEach(async () => {
    for (const d of daemons.splice(0)) d.stop();
    await app.stop();
});

const machine = (id: MachineId, principal: Principal = owner) => app.as(principal).actor(Machine, machineKey(WS, id));

/** A paired machine whose daemon reports `E1` with the one root `C:/src`, connected and online. */
async function windowsMachine(): Promise<MachineId> {
    const { machineId, pairingCode } = await app.as(owner).actor(Workspace, workspaceKey(WS)).registerMachinePending({ name: 'laptop' });
    await machine(machineId).pair(pairingCode, { name: 'laptop' });
    const d = inMemoryHarness({ machineId, environments: [{ ...inMemoryEnvironment(machineId, E1), cwdRoots: [ROOT] }] }).start({ events: 2, heartbeatMs: 600_000 }) as InMemoryDaemon;
    daemons.push(d);
    const key = machineKey(WS, machineId);
    const seat = d.dial();
    sockets.seats.set(key, seat);
    const asDaemon = machine(machineId, asMachine(machineId));
    void (async () => {
        try {
            // The reference daemon reports Linux; this one is a Windows machine.
            for (;;) await asDaemon.socketMessage(((await seat.next()) as string).replace('"os":"linux"', '"os":"windows"'));
        } catch {
            // dropped
        }
    })();
    await until(async () => (await machine(machineId).get()).online, 'the machine to come online');
    expect((await machine(machineId).get()).os).toBe('windows');
    return machineId;
}

async function agent(): Promise<AgentId> {
    const agentId = 'agent_cc' as AgentId;
    await app.as(owner).actor(AgentActor, agentKey(WS, agentId)).update({ name: 'cc', instructions: 'Be brief.', tools: [], execution: { runtime: 'in-memory', defaultEnvironmentId: E1, offlinePolicy: 'fail' } }, 'create');
    return agentId;
}

describe('MCP sessions_open with a cwd (#190)', () => {
    it('runs the session in that folder: OpenSpec.cwd, the Session record and the task carry it; no prompt text stands in for it', async () => {
        const machineId = await windowsMachine();
        const agentId = await agent();
        const port = createActorPlatformPort(client, { actors });
        const opened = await port.sessions.open({ agentId, machineId, environmentId: E1, cwd: 'C:/src/app' });
        const key = machineKey(WS, machineId);
        await until(() => sockets.frames(key).some((f) => f.t === 'session.open'), 'session.open to reach the daemon');
        expect(sockets.frames(key).find((f) => f.t === 'session.open')!.spec!.cwd).toBe('C:/src/app');
        const task = await app.as(owner).actor(TaskActor, taskKey(WS, opened.taskId)).get();
        expect(task.workdir).toBe('C:/src/app');
        expect(task.context).toEqual([]);
        await until(async () => (await app.as(owner).actor(TaskActor, taskKey(WS, opened.taskId)).get()).sessionId !== undefined, 'the task to get its session');
        const sessionId = (await app.as(owner).actor(TaskActor, taskKey(WS, opened.taskId)).get()).sessionId!;
        expect((await app.as(owner).actor(Session, `${WS}:session:${sessionId}`).get()).spec).toMatchObject({ environmentId: E1, machineId, cwd: 'C:/src/app' });
    });

    it('refuses a sibling that shares the root prefix, and a relative path, before anything is created', async () => {
        const machineId = await windowsMachine();
        const agentId = await agent();
        const port = createActorPlatformPort(client, { actors });
        expect(await statusOf(port.sessions.open({ agentId, machineId, environmentId: E1, cwd: 'C:/src2' }))).toBe(400);
        expect(await statusOf(port.sessions.open({ agentId, machineId, environmentId: E1, cwd: 'src/app' }))).toBe(400);
        // Windows rules: another case and the other separator are the same folder.
        await port.sessions.open({ agentId, machineId, environmentId: E1, cwd: 'c:\\SRC\\app' });
        await until(() => sockets.frames(machineKey(WS, machineId)).some((f) => f.t === 'session.open'), 'session.open to reach the daemon');
        expect(sockets.frames(machineKey(WS, machineId)).filter((f) => f.t === 'session.open').map((f) => f.spec!.cwd)).toEqual(['c:\\SRC\\app']);
    });
});
