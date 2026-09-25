/**
 * Several `ActorHost` objects in one isolate (#137, #126): an ambient
 * `actor()` hop made inside one object must resolve through THAT object's
 * host, never the last-booted one's.
 *
 * The shape that broke: daemon A says `hello` and is welcomed (its Machine
 * object and the Routing object boot), THEN daemon B connects and says
 * `hello`. B's Machine object boots last, so — with the current host in one
 * global — the Routing object's `machineOnline(B)` hop resolved through B's
 * host, whose placement answered `isSelf`, and B's actor ran locally inside
 * the Routing object on B's storage: "Cannot perform I/O on behalf of a
 * different Durable Object", B's object reset, its welcome lost
 * (`online: false`). A session turn after that (#126) tripped the same
 * hazard in a Session background save. Observed here through the objects'
 * state: a broken object loses its unsaved turn and its in-memory sockets,
 * so a machine welcomed but reported offline IS the cross-object hop. (The
 * error itself is reported by workerd's own logger, not through
 * `unhandledrejection` — a listener never sees it, so it cannot be asserted
 * from inside a test; the suite's output is the second check.)
 */
import { SELF } from 'cloudflare:test';
import type { AgentId, ChatId, MachineId, TaskId, WorkspaceId } from '@agentic/core';
import { createId } from '@agentic/core';
import { DAEMON_PROTOCOL_VERSION } from '@agentic/daemon-protocol';
import { IN_MEMORY_CAPABILITIES, inMemoryEnvironment } from '@agentic/daemon-protocol/testing';
import { AgentActor, Chat, TaskActor, Workspace, agentKey, defineMachineActor, machineKey, taskKey, workspaceKey, type IndexedEntry, type RoutingActor } from '@agentic/platform';
import { chatKeyOf, routingKeyOf } from '../../src/actors/keys';
import { runActivation, unknownAgent } from '../../src/pages/chat/live';
import { overHttp, setAnthropicKey, signIn } from './http';

const userId = 'gh_scope';
const WS = userId as WorkspaceId;
const ORIGIN = 'https://agentic.test';
const Machine = defineMachineActor({ socket: { send: () => false, close: () => {} } });
const Routing = { type: 'routing' } as unknown as RoutingActor;

let cookie = '';
beforeAll(async () => {
    cookie = await signIn(userId);
});

async function pairNew(name: string): Promise<{ machineId: MachineId; token: string; machine: ReturnType<typeof overHttp<typeof Machine>> }> {
    const ws = overHttp(Workspace, workspaceKey(WS), cookie);
    const { machineId, pairingCode } = await ws.registerMachinePending({ name });
    const machine = overHttp(Machine, machineKey(WS, machineId), cookie);
    const { token } = await machine.pair(pairingCode, { name });
    return { machineId, token, machine };
}

function open(response: Response): { ws: WebSocket; next(): Promise<Record<string, unknown>> } {
    const ws = response.webSocket;
    if (!ws) throw new Error(`expected a WebSocket, got HTTP ${response.status}`);
    ws.accept();
    const queue: Record<string, unknown>[] = [];
    const waiters: ((f: Record<string, unknown>) => void)[] = [];
    ws.addEventListener('message', (event) => {
        const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
        const w = waiters.shift();
        if (w) w(frame);
        else queue.push(frame);
    });
    // A frame that never comes fails with what was awaited, not as the test's own timeout (#817).
    const next = (timeoutMs = 20_000): Promise<Record<string, unknown>> => {
        if (queue.length) return Promise.resolve(queue.shift()!);
        return new Promise((resolve, reject) => {
            const waiter = (f: Record<string, unknown>): void => {
                clearTimeout(timer);
                resolve(f);
            };
            const timer = setTimeout(() => {
                waiters.splice(waiters.indexOf(waiter), 1);
                reject(new Error(`no frame from the daemon socket within ${timeoutMs} ms`));
            }, timeoutMs);
            waiters.push(waiter);
        });
    };
    return { ws, next };
}

async function connectAndHello(machineId: MachineId, token: string): Promise<ReturnType<typeof open>> {
    const socket = open(await SELF.fetch(`${ORIGIN}/_agentic/daemon/${machineId}`, { headers: { upgrade: 'websocket', authorization: `Bearer ${token}` } }));
    socket.ws.send(JSON.stringify({ v: DAEMON_PROTOCOL_VERSION, t: 'hello', machineId, daemonVersion: '0.0.0-test', os: 'windows', environments: [inMemoryEnvironment(machineId, `env_${machineId}` as never)], capabilities: [IN_MEMORY_CAPABILITIES], resume: {} }));
    expect(await socket.next()).toMatchObject({ t: 'welcome' });
    return socket;
}

async function until(check: () => Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 25));
    }
}

// Each test pairs and connects several machines and runs a session turn: a few dozen Durable Object hops, which
// ran past the suite's 30 s on the windows-latest compat runner (#817). Their waits are bounded on their own.
const HEAVY = { timeout: 90_000 };

describe('worker: several ActorHost objects in one isolate resolve ambient hops through their own host (#137)', () => {
    it('two machines say hello one after the other, then a session turn — every object intact', HEAVY, async () => {
        const a = await pairNew('alpha');
        const b = await pairNew('beta');

        // A first: its Machine object and the Routing object boot.
        const socketA = await connectAndHello(a.machineId, a.token);
        expect(await a.machine.get()).toMatchObject({ online: true, name: 'alpha' });

        // B AFTER A's welcome: B's Machine object is the last to boot.
        const socketB = await connectAndHello(b.machineId, b.token);
        expect(await b.machine.get()).toMatchObject({ online: true, name: 'beta' });
        expect(await a.machine.get()).toMatchObject({ online: true });

        // A session turn over the mock runtime (#126): the Session's background save must land in its own object.
        await setAnthropicKey(WS, cookie);
        const ws = overHttp(Workspace, workspaceKey(WS), cookie);
        const { agentId } = await ws.createAgent({ name: 'Ada' });
        await overHttp(AgentActor, agentKey(WS, agentId as AgentId), cookie).update({ name: 'Ada', instructions: 'Be brief.', execution: { runtime: 'anthropic-api', offlinePolicy: 'fail' } }, 'create');
        const { chatId } = await ws.createChat({});
        const chatKey = chatKeyOf(WS, chatId as ChatId);
        const chat = overHttp(Chat, chatKey, cookie);
        await chat.addAgent(agentId as AgentId, 'all');
        const summary = await chat.get();
        const result = await runActivation(
            {
                post: (text, mentions) => chat.post(text, mentions),
                createTask: (id, contract, owner) => overHttp(TaskActor, taskKey(WS, id), cookie).create(contract, { owner }),
                run: (taskId) => overHttp(Routing, routingKeyOf(WS), cookie).run(taskId),
                newTaskId: () => createId('task') as TaskId
            },
            { chatId: chatId as ChatId, text: 'hello from two objects', mentions: [], summary, entries: [], lookup: unknownAgent }
        );
        expect(result.tasks).toHaveLength(1);
        const entries = async (): Promise<readonly IndexedEntry[]> => (await chat.history(null, 50)).entries;
        await until(async () => (await entries()).some((e) => e.entry.t === 'msg' && e.entry.author.kind === 'agent'), 'the answer in the chat');
        const task = await overHttp(TaskActor, taskKey(WS, result.tasks[0]!.taskId), cookie).get();
        expect(['active', 'completed']).toContain(task.status);
        // The answer reached the chat through the Session's own object; the machines' objects are untouched.
        expect((await entries()).find((e) => e.entry.t === 'msg' && e.entry.author.kind === 'agent')!.entry).toMatchObject({ parts: [{ type: 'text', text: 'echo: hello from two objects' }] });

        // Both machines still online — neither object was reset.
        expect(await a.machine.get()).toMatchObject({ online: true });
        expect(await b.machine.get()).toMatchObject({ online: true });
        socketA.ws.close(1000, 'bye');
        socketB.ws.close(1000, 'bye');
        await until(async () => !(await a.machine.get()).online && !(await b.machine.get()).online, 'both offline');
    });

    // #172: the auth routes run in the Worker, OUTSIDE the actor mount. `POST /auth/pair`
    // hops ambiently to the PairingDirectory and the Machine object (`pairingWiring`);
    // unscoped, that hop resolved through the last-booted object's host — a Machine's.
    it('POST /auth/pair after two machines said hello lands on the right Machine object', HEAVY, async () => {
        const a = await pairNew('gamma');
        const b = await pairNew('delta');
        const socketA = await connectAndHello(a.machineId, a.token);
        const socketB = await connectAndHello(b.machineId, b.token);
        expect(await a.machine.get()).toMatchObject({ online: true });
        expect(await b.machine.get()).toMatchObject({ online: true });

        // A third machine, paired the way the Pair page and `agentic-daemon pair` do it: the page
        // watches the pending record (its object boots LAST), then the daemon redeems the code over
        // the auth route — not the mount. Unscoped, `isSelf` of that last host answered for the
        // target and `Machine.pair` ran inside the Worker on the object's storage: internal error.
        const ws = overHttp(Workspace, workspaceKey(WS), cookie);
        const { machineId, pairingCode } = await ws.registerMachinePending({ name: 'epsilon' });
        const c = overHttp(Machine, machineKey(WS, machineId), cookie);
        expect(await c.get()).toMatchObject({ paired: false });
        const redeemed = await SELF.fetch(`${ORIGIN}/auth/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pairingCode, name: 'epsilon' }) });
        expect(redeemed.status).toBe(200);
        const paired = (await redeemed.json()) as { machineId: MachineId; workspaceId: WorkspaceId; token: string };
        expect(paired).toMatchObject({ machineId, workspaceId: WS });
        // The token is honoured by the object it was minted in — the pair landed in the right one.
        expect(await c.get()).toMatchObject({ paired: true, name: 'epsilon', online: false });
        const socketC = await connectAndHello(machineId, paired.token);
        expect(await c.get()).toMatchObject({ online: true });

        // Neither of the first two objects was reset by the hop.
        expect(await a.machine.get()).toMatchObject({ online: true });
        expect(await b.machine.get()).toMatchObject({ online: true });
        socketA.ws.close(1000, 'bye');
        socketB.ws.close(1000, 'bye');
        socketC.ws.close(1000, 'bye');
        await until(async () => !(await a.machine.get()).online && !(await b.machine.get()).online && !(await c.get()).online, 'all offline');
    });
});
