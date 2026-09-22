/**
 * The hub actors hand slow work off (#492): a Session whose turn-end is slow —
 * the transcript fold, learning, the chat publish — holds neither the Machine
 * that hosts it nor the Routing actor, so a message in another chat on the
 * same machine still gets its session. The host's call deadline is short here
 * (`callTimeoutMs`), so a hub that waits on the stuck session fails the way
 * prod did at 30 s: `run()` for the second task throws `call-timeout`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actorKey, type AgentId, type EnvironmentId, type MachineId, type Principal, type TaskContract, type TaskId, type WorkspaceId } from '@agentic/core';
import { inMemoryEnvironment, inMemoryHarness, type InMemoryDaemon, type PlatformSeat } from '@agentic/daemon-protocol/testing';
import { learningPlugin, memoryCorrectionLedger } from '@agentic/learning';

import { AgentActor, agentKey } from '../../src/agent/index';
import { workspaceKey } from '../../src/auth/index';
import { defineMachineActor, machineKey, parseMachineKey, type MachineSocketPort } from '../../src/machine/index';
import { Memory } from '../../src/memory/index';
import { PairingDirectory } from '../../src/pairing/index';
import { createToolCallPort, defineRoutingActor, routingKey } from '../../src/routing/index';
import { defineSessionActor, type CommandSink } from '../../src/session/index';
import { platformLearningPorts } from '../../src/task/index';
import { TaskActor, taskKey, type TaskView } from '../../src/task/index';
import { Workspace } from '../../src/workspace/index';
import { QUIET_DEFAULTS, testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const E1 = 'env_1' as EnvironmentId;
const asMachine = (id: MachineId): Principal => ({ kind: 'machine', workspaceId: WS, machineId: id });
/** Well under the 4 s a wait here allows, well over one turn: a hub that waits on the stuck session fails, one that hands off does not. */
const CALL_TIMEOUT_MS = 800;

class FakeSockets implements MachineSocketPort {
    readonly seats = new Map<string, PlatformSeat>();
    connected = new Set<string>();
    send(key: string, text: string): boolean {
        if (!this.connected.has(key)) return false;
        this.seats.get(key)?.send(JSON.parse(text));
        return true;
    }
    close(key: string): void {
        this.seats.get(key)?.drop();
        this.seats.delete(key);
        this.connected.delete(key);
    }
}

const until = async (check: () => Promise<boolean> | boolean, what: string, timeoutMs = 4_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
};

/** A gate the Session's turn-end waits at: `verify` holds until `release()`. */
function gate(): { readonly entered: Promise<void>; release(): void; verify(): Promise<undefined> } {
    let enter!: () => void;
    let open!: () => void;
    const entered = new Promise<void>((r) => (enter = r));
    const opened = new Promise<void>((r) => (open = r));
    return {
        entered,
        release: () => open(),
        verify: async () => {
            enter();
            await opened;
            return undefined;
        }
    };
}

let app: TestActorApp;
let sockets: FakeSockets;
let stuck: ReturnType<typeof gate>;
let Session: ReturnType<typeof defineSessionActor>;
let Machine: ReturnType<typeof defineMachineActor>;
let Routing: ReturnType<typeof defineRoutingActor>;
const daemons: InMemoryDaemon[] = [];

beforeEach(async () => {
    sockets = new FakeSockets();
    stuck = gate();
    const sink: CommandSink = { send: (t, cmd) => app.as(owner).actor(Machine, machineKey(t.workspaceId, t.machineId)).sendCommand(t.sessionId, cmd) };
    const ledger = memoryCorrectionLedger();
    Session = defineSessionActor({
        factory: async () => null,
        commands: sink,
        // Learning runs in the turn-end (`learnFromTurn`); its verification is where this session gets stuck.
        learning: platformLearningPorts({ plugin: (c) => learningPlugin({ ledger, contextFor: () => ({ objective: c.objective, tags: c.tags }) }), verify: () => stuck.verify() })
    });
    Routing = defineRoutingActor({ sessions: () => Session, machines: () => Machine });
    Machine = defineMachineActor({ socket: sockets, sessions: () => Session, routing: () => Routing, tools: createToolCallPort({ routing: () => Routing, sessions: () => Session }) });
    app = testActorApp([Routing, Session, Machine, TaskActor, AgentActor, Workspace, PairingDirectory, Memory], { defaults: { ...QUIET_DEFAULTS, callTimeoutMs: CALL_TIMEOUT_MS } });
    await app.start();
});

afterEach(async () => {
    stuck.release();
    for (const d of daemons.splice(0)) d.stop();
    await app.stop();
});

const routing = () => app.as(owner).actor(Routing, routingKey(WS));
const task = (id: string) => app.as(owner).actor(TaskActor, taskKey(WS, id as TaskId));
const machine = (id: MachineId, principal: Principal = owner) => app.as(principal).actor(Machine, machineKey(WS, id));
const session = (id: string) => app.as(owner).actor(Session, actorKey(WS, 'session', id));

async function agent(id: string): Promise<AgentId> {
    const agentId = id as AgentId;
    await app.as(owner).actor(AgentActor, agentKey(WS, agentId)).update({ name: id, instructions: 'Be brief.', tools: [{ name: 'task_report' }], approvalPolicy: [], execution: { offlinePolicy: 'fail', runtime: 'in-memory', defaultEnvironmentId: E1 } }, 'create');
    return agentId;
}

async function createTask(id: string, assignee: AgentId, extra: Partial<TaskContract> = {}): Promise<TaskView> {
    return task(id).create({ objective: 'do the thing', origin: { kind: 'external', clientId: 'c1' }, assignee, context: [], constraints: {}, ...extra }, { owner: assignee });
}

async function pairMachine(name: string): Promise<MachineId> {
    const { machineId, pairingCode } = await app.as(owner).actor(Workspace, workspaceKey(WS)).registerMachinePending({ name });
    await machine(machineId).pair(pairingCode, { name });
    return machineId;
}

function connect(machineId: MachineId): void {
    const d = inMemoryHarness({ machineId, environments: [inMemoryEnvironment(machineId, E1)] }).start({ events: 3, heartbeatMs: 600_000 }) as InMemoryDaemon;
    daemons.push(d);
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
    })();
}

const online = (id: MachineId) => until(async () => (await machine(id).get()).online, `${id} online`);
const settled = (id: string) => until(async () => ['completed', 'failed', 'cancelled'].includes((await task(id).get()).status), `task ${id} to settle`);

describe('hub actors and a stuck session (#492)', () => {
    it('a Session stuck in its turn-end holds neither the Machine nor the router: a second task on the same machine still opens its session', async () => {
        const m1 = await pairMachine('laptop');
        connect(m1);
        await online(m1);
        const a = await agent('agent_a');
        const b = await agent('agent_b');
        await createTask('t1', a);
        await routing().run('t1' as TaskId);
        // The daemon ran t1's turn; its Session is now inside `forwardFrames` → `finishTurn` → learning, waiting at the gate.
        await stuck.entered;
        await createTask('t2', b);
        // Another agent's message on the same machine: placement reads the Machine and opens a session there.
        const started = await routing().run('t2' as TaskId);
        expect(started.status).toBe('active');
        await until(async () => (await task('t2').get()).sessionId !== undefined && (await session((await task('t2').get()).sessionId!).get()).opened, 't2 to get a session');
        // The machine is not held either: it still answers while t1's session waits.
        expect((await machine(m1).get()).activeSessions.map((s) => s.taskId).sort()).toEqual(['t1', 't2']);
        stuck.release();
        await settled('t1');
        await settled('t2');
        expect((await task('t1').get()).status).toBe('completed');
        expect((await task('t2').get()).status).toBe('completed');
    });
});
