/**
 * The workerd half of the acceptance suite (docs/acceptance.md): helpers for
 * the scenarios that run against the real `ActorHost` Durable Objects —
 * the Worker of `./worker.ts` (a mock `anthropic-api` runtime, every other
 * port the production wiring), over the HTTP actor mount, with
 * an `InMemoryDaemon` bridged onto a REAL daemon WebSocket at
 * `/_agentic/daemon/{machineId}` so the Machine object talks to it exactly
 * as it talks to `agentic-daemon`.
 */
import { SELF } from 'cloudflare:test';
import type { AgentId, EnvironmentDescriptor, EnvironmentId, MachineId, OfflinePolicy, RuntimeId, TaskContract, TaskId, WorkspaceId } from '@agentic/core';
import { inMemoryHarness, type InMemoryDaemon, type PlatformSeat } from '@agentic/daemon-protocol/testing';
import { AgentActor, TaskActor, Workspace, agentKey, defineMachineActor, defineScheduleActor, machineKey, taskKey, workspaceKey, type RoutingActor, type SessionActor, type TaskView } from '@agentic/platform';
import { routingKeyOf, sessionKeyOf } from '../../src/actors/keys';
import { overHttp, signIn } from '../workers/http';

export { overHttp, signIn };

export const ORIGIN = 'https://agentic.test';

/** Definitions for `overHttp` — only their `type` matters on the wire; the host runs the app's own. */
export const Machine = defineMachineActor({ socket: { send: () => false, close: () => {} } });
export const Schedule = defineScheduleActor({ trigger: { fired: () => undefined } });
export const Routing = { type: 'routing' } as unknown as RoutingActor;
export const Session = { type: 'session' } as unknown as SessionActor;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Budgets for the slow Windows runner (#179): there the pool runs ~10× slower than a dev box and a single Durable
 * Object turn can hold for 7–10 s, so a wait that takes 2 s locally needs tens of seconds. `WAIT_MS` bounds one
 * wait; `SCENARIO_MS` is the test timeout of a scenario chaining several — larger than any single wait, so a stuck
 * step fails with its own message (and the task record, for `settled`) instead of a bare "Test timed out".
 */
export const WAIT_MS = 30_000;
export const SCENARIO_MS = 150_000;

/** Poll until `check()` holds. Every poll is a request into the pool: poll gently, the runner is starved already. */
export async function until(check: () => Promise<boolean> | boolean, what: string, timeoutMs = WAIT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await sleep(50);
    }
}

/** One signed-in user and the clients the scenarios need, all over the Worker's HTTP mount. */
export interface Actor {
    readonly userId: string;
    readonly ws: WorkspaceId;
    readonly cookie: string;
    workspace(): ReturnType<typeof overHttp<typeof Workspace>>;
    machine(machineId: MachineId): ReturnType<typeof overHttp<typeof Machine>>;
    task(taskId: string): ReturnType<typeof overHttp<typeof TaskActor>>;
    routing(): ReturnType<typeof overHttp<RoutingActor>>;
    session(sessionId: string): ReturnType<typeof overHttp<SessionActor>>;
    /** Register + pair a machine in the workspace, so the router can find its environments. */
    pairMachine(name: string): Promise<{ machineId: MachineId; token: string }>;
    /** An agent in the workspace index, configured for `execution` (its tools: `task_report`, so a daemon runtime can report). */
    agent(name: string, execution: { runtime: RuntimeId; defaultEnvironmentId?: EnvironmentId; offlinePolicy?: OfflinePolicy }): Promise<AgentId>;
    createTask(id: string, assignee: AgentId, extra?: Partial<TaskContract>): Promise<TaskView>;
    /** Wait for the task to leave the running states; throws with the record on timeout. */
    settled(id: string): Promise<TaskView>;
}

export async function signInAs(userId: string): Promise<Actor> {
    const cookie = await signIn(userId);
    const ws = userId as WorkspaceId;
    const task = (id: string) => overHttp(TaskActor, taskKey(ws, id as TaskId), cookie);
    const machine = (machineId: MachineId) => overHttp(Machine, machineKey(ws, machineId), cookie);
    return {
        userId,
        ws,
        cookie,
        workspace: () => overHttp(Workspace, workspaceKey(ws), cookie),
        machine,
        task,
        routing: () => overHttp(Routing, routingKeyOf(ws), cookie),
        session: (sessionId) => overHttp(Session, sessionKeyOf(ws, sessionId), cookie),
        async pairMachine(name) {
            const { machineId, pairingCode } = await overHttp(Workspace, workspaceKey(ws), cookie).registerMachinePending({ name });
            const { token } = await machine(machineId).pair(pairingCode, { name });
            return { machineId, token };
        },
        async agent(name, execution) {
            const { agentId } = await overHttp(Workspace, workspaceKey(ws), cookie).createAgent({ name });
            await overHttp(AgentActor, agentKey(ws, agentId), cookie).update({ name, instructions: 'Be brief.', tools: [{ name: 'task_report' }], execution: { offlinePolicy: 'fail', ...execution } }, 'create');
            return agentId;
        },
        createTask(id, assignee, extra = {}) {
            return task(id).create({ objective: `do ${id}`, origin: { kind: 'external', clientId: 'acceptance' }, assignee, context: [], constraints: {}, ...extra }, { owner: assignee });
        },
        async settled(id) {
            const done = (t: TaskView) => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled';
            try {
                await until(async () => done(await task(id).get()), `task ${id} to settle`);
            } catch (e) {
                const t = await task(id).get();
                throw new Error(`${(e as Error).message}\n${JSON.stringify({ status: t.status, wait: t.wait, error: t.error, transitions: t.transitions }, null, 1)}`);
            }
            return task(id).get();
        }
    };
}

/** The transitions of a task as `from>to` edges. */
export const edges = (t: TaskView): string[] => t.transitions.map((x) => `${x.from}>${x.to}`);

export interface DaemonScript {
    /** Session event frames per prompt (the last is `turn-end`); default 3. */
    readonly events?: number;
    /** A client tool the runtime calls once per prompt — `task_report` completes the task with its output. */
    readonly tool?: { readonly name: string; readonly input: unknown };
}

/** An in-memory daemon for `machineId` reporting `environments`, its runtime scripted; heartbeats never fire on their own. */
export function daemonFor(machineId: MachineId, environments: readonly EnvironmentDescriptor[], script: DaemonScript = {}): InMemoryDaemon {
    return inMemoryHarness({ machineId, environments }).start({ events: script.events ?? 3, heartbeatMs: 600_000, ...(script.tool ? { tool: script.tool } : {}) }) as InMemoryDaemon;
}

/** A daemon's live connection to its Machine object: the socket, the platform seat behind it, every frame the platform sent. */
export interface DaemonLink {
    readonly ws: WebSocket;
    readonly seat: PlatformSeat;
    /** Every frame the platform sent, parsed, in order (`welcome`, `session.open`, …). */
    readonly received: Record<string, unknown>[];
    /** The `welcome` the Machine object answered the daemon's `hello` with. */
    welcomed(): Promise<Record<string, unknown>>;
    /** Drop the connection from the daemon side — the machine goes offline at once. */
    close(): void;
}

/**
 * Dial the daemon socket for `machineId` with its machine token and bridge
 * `daemon` onto it: what the daemon emits goes over the socket, what the
 * platform sends is fed to the daemon. The daemon's `hello` goes first.
 */
export async function connectDaemon(machineId: MachineId, token: string, daemon: InMemoryDaemon): Promise<DaemonLink> {
    const response = await SELF.fetch(`${ORIGIN}/_agentic/daemon/${machineId}`, { headers: { upgrade: 'websocket', authorization: `Bearer ${token}` } });
    const ws = response.webSocket;
    if (!ws) throw new Error(`expected a WebSocket upgrade, got HTTP ${response.status}`);
    ws.accept();
    const seat = daemon.dial();
    const received: Record<string, unknown>[] = [];
    ws.addEventListener('message', (event) => {
        const text = String(event.data);
        received.push(JSON.parse(text) as Record<string, unknown>);
        seat.sendRaw!(text);
    });
    ws.addEventListener('close', () => seat.drop());
    void (async () => {
        try {
            for (;;) ws.send((await seat.next()) as string);
        } catch {
            // the seat was dropped: the daemon went away
        }
    })();
    return {
        ws,
        seat,
        received,
        async welcomed() {
            await until(() => received.some((f) => f.t === 'welcome'), `the welcome of ${machineId}`);
            return received.find((f) => f.t === 'welcome')!;
        },
        close() {
            seat.drop();
            ws.close(1000, 'bye');
        }
    };
}

/** The `session.open` frames the platform sent over a link, by session. */
export const opens = (link: DaemonLink): { sessionId: string; environmentId: string }[] => link.received.filter((f) => f.t === 'session.open') as unknown as { sessionId: string; environmentId: string }[];
