/**
 * `cloudflare:test` on the Node host (#995): what `vitest.node.config.ts` aliases the module to, so the
 * `__tests__/workers/*` acceptance suite runs unchanged against `createNodeHost` (`apps/node`) on an in-memory
 * SQLite database, as it runs against the `ActorHost` Durable Object inside workerd.
 *
 * One host per test file (vitest isolates each file's modules), wired like `../workers/worker.ts`: the same test
 * seams (`../workers/fixture.ts`) ahead of the host's own routes. What the workers pool gives a test, here:
 *
 * - `SELF.fetch` — `NodeHost.fetch` in-process. A WebSocket upgrade is answered the way `apps/node/src/server.ts`
 *   answers one, with an in-memory socket pair: the test holds the Workers-shaped end (`response.webSocket`,
 *   `accept()`, `send`, `close`, `message` / `close` events), the host the other.
 * - `env.ACTORS` — a namespace whose stubs only name an actor (`durableObjectName`: `type \0 key`); `env.ARTIFACTS`
 *   — the host's bucket (`fsBucket` in a temp directory).
 * - `evictDurableObject` — `host.deactivate` (the activation drains and goes; state is reloaded from storage).
 * - `runDurableObjectAlarm` — the reminder tick runs every `REMINDER_TICK_MS`; this waits for the actor's due
 *   reminders to be delivered, answering whether there were any.
 * - `runInDurableObject` — `instance.host()` is the Node host; `state.storage` answers `getAlarm()` (the actor's
 *   earliest reminder), `get('sigx:reminders')` (its reminder table) and `list()` (its state record, under the
 *   Durable Object's key) from the host's storage.
 *
 * What only a Durable Object has (a stub's own `fetch`, hibernated sockets) is not emulated: those tests say
 * `onWorkerd` (`../workers/host-kind.ts`).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import type { ActorRef, AnyActorDefinition, Host } from '@sigx/actors';
import { REMINDER_TYPE } from '@sigx/actors/host';
import type { ActorSocketSession } from '@sigx/actors/server';
import { fsBucket } from '../../../node/src/fs-bucket';
import { createNodeHost } from '../../../node/src/host';
import { sqliteStorage } from '../../../node/src/storage/sqlite';
import { DAEMON_SOCKET_PREFIX } from '../../src/daemon';
import { runWithHost } from '../../src/host-scope';
import { connectorsRoute, testPorts, testRoute } from '../workers/fixture';
import { TEST_DEV_LOGIN, TEST_SESSION_SECRET, TEST_WORKSPACE_KEK } from '../workers/secret';

/** The reminder tick: a Durable Object fires its alarm on time, so the Node host ticks often. */
const REMINDER_TICK_MS = 25;
const ACTOR_SOCKET_PATH = '/_sigx/socket';
/** The reminder table's shards (`reminderShardKeys()` in `@sigx/actors`: `p0`..`p15`, pinned forever). */
const REMINDER_SHARDS = Array.from({ length: 16 }, (_, i) => `p${i}`);

const dir = await mkdtemp(join(tmpdir(), 'agentic-node-acceptance-'));
const storage = sqliteStorage({ path: ':memory:' });
const bucket = fsBucket(join(dir, 'files'));
const nodeEnv = { SESSION_SECRET: TEST_SESSION_SECRET, WORKSPACE_KEK: TEST_WORKSPACE_KEK, AGENTIC_DEV_LOGIN: TEST_DEV_LOGIN };
let registry: readonly AnyActorDefinition[] = [];
const node = await createNodeHost({ storage, bucket, env: nodeEnv, ports: testPorts(() => registry), defaults: { reminderTickMs: REMINDER_TICK_MS } });
registry = node.actors;
const host: Host = node.host;

afterAll(async () => {
    await node.stop({ timeoutMs: 2_000 }).catch(() => undefined);
    storage.close();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

const waitUntil = { waitUntil: (promise: Promise<unknown>) => void promise.catch(() => undefined) };

/** Every HTTP route, in the Worker fixture's order: the test routes, then the host's (dev login, auth, A2A, files, connectors, actors). */
function handle(request: Request): Promise<Response> {
    const test = testRoute(request) ?? connectorsRoute(request, nodeEnv);
    if (test) return runWithHost(host, () => test(request));
    return node.fetch(request, waitUntil);
}

// ---- WebSockets ----------------------------------------------------------------------------------------------

type Listener = (event: Event) => void;

/** The test's end of an accepted upgrade: the slice of a Workers `WebSocket` the suite uses. */
class TestSocket {
    readyState = 1;
    #accepted = false;
    #backlog: Event[] = [];
    readonly #listeners = new Map<string, Set<Listener>>();
    constructor(
        private readonly toHost: (text: string) => void,
        private readonly hostClose: (code: number, reason: string) => void
    ) {}

    accept(): void {
        this.#accepted = true;
        for (const event of this.#backlog.splice(0)) this.#dispatch(event);
    }
    addEventListener(type: string, listener: Listener): void {
        let set = this.#listeners.get(type);
        if (!set) this.#listeners.set(type, (set = new Set()));
        set.add(listener);
    }
    removeEventListener(type: string, listener: Listener): void {
        this.#listeners.get(type)?.delete(listener);
    }
    send(data: string | ArrayBuffer | ArrayBufferView): void {
        if (this.readyState !== 1) throw new Error('WebSocket is closed');
        const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
        setTimeout(() => this.toHost(text), 0);
    }
    close(code = 1000, reason = ''): void {
        if (this.readyState !== 1) return;
        this.readyState = 3;
        setTimeout(() => {
            this.hostClose(code, reason);
            this.#emit(Object.assign(new Event('close'), { code, reason, wasClean: true }));
        }, 0);
    }

    /** The host sent a frame. */
    fromHost(text: string): void {
        if (this.readyState !== 1) return;
        setTimeout(() => this.#emit(new MessageEvent('message', { data: text })), 0);
    }
    /** The host closed the socket. */
    closedByHost(code = 1000, reason = ''): void {
        if (this.readyState !== 1) return;
        this.readyState = 3;
        setTimeout(() => this.#emit(Object.assign(new Event('close'), { code, reason, wasClean: true })), 0);
    }

    #emit(event: Event): void {
        if (this.#accepted) this.#dispatch(event);
        else this.#backlog.push(event);
    }
    #dispatch(event: Event): void {
        for (const listener of [...(this.#listeners.get(event.type) ?? [])]) listener(event);
    }
}

/** A `101` carrying the test's end, as workerd answers an accepted upgrade (`new Response` refuses status 101). */
function switching(socket: TestSocket): Response {
    const response = new Response(null, { status: 200 });
    Object.defineProperty(response, 'status', { value: 101 });
    Object.defineProperty(response, 'webSocket', { value: socket });
    return response;
}

/** `/_sigx/socket/*`: accepted, then the session's prelude (origin, auth) runs — a refusal closes it (1008), as `server.ts` does. */
function actorSocket(request: Request): Response {
    const pending: string[] = [];
    let session: ActorSocketSession | undefined;
    let closed = false;
    const socket = new TestSocket(
        (text) => {
            if (session) session.handle(text);
            else pending.push(text);
        },
        () => {
            closed = true;
            session?.close();
        }
    );
    node.openActorSocket(
        request,
        (message) => socket.fromHost(message),
        (code, reason) => {
            socket.closedByHost(code, reason);
            // As the `ws` 'close' event does in `server.ts`: the session hears its own close, a turn later.
            setTimeout(() => {
                closed = true;
                session?.close();
            }, 0);
        }
    ).then(
        (opened) => {
            if (closed) return opened.close();
            session = opened;
            for (const text of pending.splice(0)) opened.handle(text);
        },
        () => undefined
    );
    return switching(socket);
}

/** `/_agentic/daemon/{id}`: the token checked before the upgrade; frames handled one at a time, in order. */
async function daemonSocket(request: Request): Promise<Response> {
    const who = await node.daemon.verify(request);
    if (who instanceof Response) return who;
    let queue = Promise.resolve();
    const onError = (e: unknown) => console.error('[node acceptance] daemon frame failed:', e);
    const hostEnd = {
        send: (text: string) => socket.fromHost(text),
        close: (code?: number, reason?: string) => {
            socket.closedByHost(code, reason);
            queue = queue.then(() => node.daemon.closed(who, hostEnd)).catch(onError);
        }
    };
    const socket: TestSocket = new TestSocket(
        (text) => {
            queue = queue.then(() => node.daemon.message(who, hostEnd, text)).catch(onError);
        },
        () => {
            queue = queue.then(() => node.daemon.closed(who, hostEnd)).catch(onError);
        }
    );
    node.daemon.opened(who, hostEnd);
    return switching(socket);
}

export const SELF = {
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        // A streamed body needs `duplex` on Node's `Request`; workerd infers it.
        const request = new Request(input, init?.body instanceof ReadableStream ? ({ ...init, duplex: 'half' } as RequestInit) : init);
        if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
            const { pathname } = new URL(request.url);
            if (pathname === ACTOR_SOCKET_PATH || pathname.startsWith(`${ACTOR_SOCKET_PATH}/`)) return actorSocket(request);
            if (pathname.startsWith(DAEMON_SOCKET_PREFIX)) return daemonSocket(request);
        }
        return handle(request);
    }
};

// ---- Durable Object stand-ins --------------------------------------------------------------------------------

interface StubLike {
    readonly name: string;
    readonly ref: ActorRef;
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/** `durableObjectName(ref)` back to the ref: `type \0 key`. */
function refOf(name: string): ActorRef {
    const at = name.indexOf('\0');
    if (at < 0) throw new Error(`[node acceptance] not an actor object name: ${JSON.stringify(name)}`);
    return { type: name.slice(0, at), key: name.slice(at + 1) };
}

const namespace = {
    idFromName: (name: string) => ({ name, toString: () => name }),
    get(id: { name: string }): StubLike {
        return {
            name: id.name,
            ref: refOf(id.name),
            // A Durable Object's own fetch (the purge endpoint) has no Node counterpart.
            fetch: async () => new Response('no Durable Object on the Node host', { status: 501 })
        };
    }
};

export const env = { ACTORS: namespace, ARTIFACTS: bucket, SESSION_SECRET: TEST_SESSION_SECRET, WORKSPACE_KEK: TEST_WORKSPACE_KEK, AGENTIC_DEV_LOGIN: TEST_DEV_LOGIN };

type ReminderTable = Record<string, Record<string, { nextDue: number; period?: number }>>;

/** The actor's rows of the sharded reminder table, straight from storage. */
async function remindersOf(ref: ActorRef): Promise<Record<string, { nextDue: number; period?: number }>> {
    const id = `${ref.type}\0${ref.key}`;
    const rows: Record<string, { nextDue: number; period?: number }> = {};
    for (const shard of REMINDER_SHARDS) {
        const record = await storage.load(REMINDER_TYPE, shard);
        Object.assign(rows, (record?.state as ReminderTable | undefined)?.[id] ?? {});
    }
    return rows;
}

async function alarmOf(ref: ActorRef): Promise<number | null> {
    const dues = Object.values(await remindersOf(ref)).map((r) => r.nextDue);
    return dues.length ? Math.min(...dues) : null;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** The actor's activation has no unsettled turn (`host.activations`), and nothing is activating. */
async function settled(ref: ActorRef): Promise<void> {
    for (let i = 0; i < 400; i++) {
        const stats = host.stats();
        const own = host.activations({ type: ref.type, limit: 10_000 }).find((a) => a.key === ref.key);
        if (stats.transitional.activating === 0 && (own?.queued ?? 0) === 0) return;
        await sleep(5);
    }
}

export async function evictDurableObject(stub: StubLike, _options?: { webSockets?: 'hibernate' }): Promise<void> {
    await host.deactivate(stub.ref, 'explicit');
}

/** Wait for the actor's due reminders to be delivered by the tick; `true` when there were any. */
export async function runDurableObjectAlarm(stub: StubLike): Promise<boolean> {
    const due = async () => Object.values(await remindersOf(stub.ref)).some((r) => r.nextDue <= Date.now());
    if (!(await due())) {
        await settled(stub.ref);
        return false;
    }
    const deadline = Date.now() + 10_000;
    while ((await due()) && Date.now() < deadline) await sleep(REMINDER_TICK_MS);
    // The tick removes a reminder from the table, then delivers it: let that turn land.
    await sleep(REMINDER_TICK_MS);
    await settled(stub.ref);
    return true;
}

export async function runInDurableObject<R>(stub: StubLike, fn: (instance: { host(): Promise<Host> }, state: unknown) => R | Promise<R>): Promise<R> {
    const ref = stub.ref;
    const state = {
        storage: {
            getAlarm: () => alarmOf(ref),
            async get(key: string): Promise<unknown> {
                return key === 'sigx:reminders' ? remindersOf(ref) : undefined;
            },
            /** The actor's record under the key a Durable Object keeps it (`sigx:state \0 type \0 key`), when there is one. */
            async list(): Promise<Map<string, unknown>> {
                const record = await storage.load(ref.type, ref.key);
                return new Map(record ? [[`sigx:state\0${ref.type}\0${ref.key}`, record.state]] : []);
            }
        }
    };
    return fn({ host: async () => host }, state);
}
