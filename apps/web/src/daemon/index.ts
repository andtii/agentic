/**
 * The daemon socket on Cloudflare (architecture §3, §5b; issue #36).
 *
 * `wss://…/_agentic/daemon/{machineId}` with `Authorization: Bearer amt.…`:
 *
 * - Worker half (`forwardDaemonSocket`): the token names the workspace and
 *   machine, so the upgrade is forwarded — verbatim — to that Machine's
 *   Durable Object. Nothing is proved here; a malformed or mismatched
 *   token is refused early so no object wakes for it.
 * - Object half (`createDaemonSocketHost`): the Machine actor's stored hash
 *   decides (`verifyMachineToken`; a revoked machine is refused at connect),
 *   the server end is accepted with the hibernation API under the
 *   `agentic:daemon` tag, and every message is handed to
 *   `Machine.socketMessage` under the machine principal. A close or error
 *   marks the machine offline at once through `Machine.socketClosed`.
 * - `createDaemonSocketRegistry` is the `MachineSocketPort` the actor sends
 *   through: actor key → the object's `state.getWebSockets(tag)`, bound by
 *   the object when it is constructed (its id names the actor).
 *
 * `cloudflare:workers` is not imported (the same reason as in
 * `@sigx/actors-cloudflare`): `WebSocketPair` is read off `globalThis`, so
 * this module loads — and its Worker half is testable — outside workerd.
 */
import type { MachineId, Principal, WorkspaceId } from '@agentic/core';
import { asPrincipal, bearerToken, machineKey, machinePrincipal, parseMachineKey, parseMachineToken, verifyMachineToken, type MachineActor, type MachineSocketPort } from '@agentic/platform';
import type { Host } from '@sigx/actors';
import { durableObjectName, durableObjectStubResolver, type DurableObjectNamespaceLike, type DurableObjectStateLike, type DurableWebSocketLike } from '@sigx/actors-cloudflare';

export const DAEMON_SOCKET_PREFIX = '/_agentic/daemon/';
/** The hibernation tag daemon sockets are accepted under — never `sigx:socket`, the actor host's own. */
export const DAEMON_SOCKET_TAG = 'agentic:daemon';

/** What survives an eviction on the socket (≤ 2 KiB): enough to name the actor and mint the principal. */
interface DaemonAttachment {
    readonly v: 1;
    readonly kind: 'daemon';
    readonly key: string;
    readonly workspaceId: WorkspaceId;
    readonly machineId: MachineId;
}

const json = (body: unknown, status: number): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

/** The machine id in `/_agentic/daemon/{machineId}` (exactly one segment), or `null`. */
export function parseDaemonSocketPath(pathname: string): string | null {
    if (!pathname.startsWith(DAEMON_SOCKET_PREFIX)) return null;
    const rest = pathname.slice(DAEMON_SOCKET_PREFIX.length);
    if (!rest || rest.includes('/')) return null;
    try {
        return decodeURIComponent(rest);
    } catch {
        return null;
    }
}

const isUpgrade = (request: Request): boolean => request.headers.get('upgrade')?.toLowerCase() === 'websocket';

/** The ids a daemon request names when its path and bearer token agree; a refusal otherwise. */
function identify(request: Request): { workspaceId: WorkspaceId; machineId: MachineId; key: string; token: string } | Response {
    const machineId = parseDaemonSocketPath(new URL(request.url).pathname);
    if (machineId === null) return json({ error: 'not_found' }, 404);
    if (!isUpgrade(request)) return json({ error: 'upgrade_required', detail: 'the daemon socket is a WebSocket' }, 426);
    const token = bearerToken(request.headers);
    const ref = parseMachineToken(token);
    if (!token || !ref) return json({ error: 'unauthorized', reason: 'malformed' }, 401);
    if (ref.machineId !== machineId) return json({ error: 'forbidden', detail: 'the token names another machine' }, 403);
    return { ...ref, key: machineKey(ref.workspaceId, ref.machineId), token };
}

/** Worker half: forward the upgrade to the machine's Durable Object, or refuse it before any object wakes. */
export function forwardDaemonSocket(request: Request, namespace: DurableObjectNamespaceLike): Response | Promise<Response> {
    const who = identify(request);
    if (who instanceof Response) return who;
    return durableObjectStubResolver({ namespace }).stub({ type: 'machine', key: who.key }).fetch(request);
}

export interface DaemonSocketRegistry {
    readonly port: MachineSocketPort;
    /** Called by a Machine object once it knows its actor key. */
    bind(key: string, state: DurableObjectStateLike): void;
    sockets(key: string): DurableWebSocketLike[];
}

/** The `MachineSocketPort` over the objects' hibernated sockets. One per isolate. */
export function createDaemonSocketRegistry(): DaemonSocketRegistry {
    const states = new Map<string, DurableObjectStateLike>();
    const sockets = (key: string): DurableWebSocketLike[] => states.get(key)?.getWebSockets?.(DAEMON_SOCKET_TAG) ?? [];
    return {
        bind: (key, state) => void states.set(key, state),
        sockets,
        port: {
            send(key, text) {
                let sent = 0;
                for (const ws of sockets(key)) {
                    try {
                        ws.send(text);
                        sent++;
                    } catch {
                        // A socket already gone: its close event follows.
                    }
                }
                return sent > 0;
            },
            close(key, code, reason) {
                for (const ws of sockets(key)) {
                    try {
                        ws.close(code, reason);
                    } catch {
                        // already closed
                    }
                }
            }
        }
    };
}

/** The actor key a Durable Object serves, from its own id — `durableObjectName` is `${type}\0${key}`. */
export function actorKeyOfObject(state: DurableObjectStateLike): { type: string; key: string } | null {
    const name = state.id.name;
    if (typeof name !== 'string') return null;
    const i = name.indexOf('\0');
    return i > 0 ? { type: name.slice(0, i), key: name.slice(i + 1) } : null;
}

export interface DaemonSocketHostOptions {
    readonly state: DurableObjectStateLike;
    readonly host: () => Promise<Host>;
    readonly machine: MachineActor;
    readonly registry: DaemonSocketRegistry;
}

export interface DaemonSocketHost {
    /** The daemon upgrade, or `null` when the request is not one. */
    fetch(request: Request): Promise<Response> | null;
    /** A socket this host accepted (survives eviction: read off the attachment). */
    owns(ws: DurableWebSocketLike): boolean;
    message(ws: DurableWebSocketLike, message: unknown): Promise<void>;
    close(ws: DurableWebSocketLike): Promise<void>;
}

interface WebSocketPairLike {
    new (): { 0: unknown; 1: DurableWebSocketLike };
}

/** Object half: accept the daemon's socket in the Machine's own object and route its messages to the actor. */
export function createDaemonSocketHost(options: DaemonSocketHostOptions): DaemonSocketHost {
    const { state, machine, registry } = options;

    const attachment = (ws: DurableWebSocketLike): DaemonAttachment | null => {
        try {
            const a = ws.deserializeAttachment() as Partial<DaemonAttachment> | null | undefined;
            return a && a.v === 1 && a.kind === 'daemon' && typeof a.key === 'string' ? (a as DaemonAttachment) : null;
        } catch {
            return null;
        }
    };

    const as = async (principal: Principal, key: string) => (await options.host()).actor(machine, key).with({ context: asPrincipal(principal) });

    return {
        fetch(request) {
            if (parseDaemonSocketPath(new URL(request.url).pathname) === null) return null;
            return (async () => {
                const who = identify(request);
                if (who instanceof Response) return who;
                const expected = durableObjectName({ type: 'machine', key: who.key });
                if (state.id.name !== expected) return json({ error: 'misrouted', detail: `this object is not ${who.key}` }, 403);
                if (typeof state.acceptWebSocket !== 'function') return json({ error: 'unsupported', detail: 'no WebSocket hibernation API on this runtime' }, 500);
                const Pair = (globalThis as { WebSocketPair?: WebSocketPairLike }).WebSocketPair;
                if (typeof Pair !== 'function') return json({ error: 'unsupported', detail: 'WebSocketPair is not available' }, 500);

                const principal = machinePrincipal(who.workspaceId, who.machineId);
                const record = await (await as(principal, who.key)).tokenRecord();
                const verdict = await verifyMachineToken(who.token, record);
                if (!verdict.ok) return json({ error: 'unauthorized', reason: verdict.reason }, 401);

                registry.bind(who.key, state);
                // One daemon per machine: a redial replaces the socket it lost.
                for (const old of registry.sockets(who.key)) {
                    try {
                        old.close(1000, 'replaced by a new daemon connection');
                    } catch {
                        // already gone
                    }
                }
                const pair = new Pair();
                const client = pair[0];
                const server = pair[1];
                state.acceptWebSocket(server, [DAEMON_SOCKET_TAG]);
                server.serializeAttachment({ v: 1, kind: 'daemon', key: who.key, workspaceId: who.workspaceId, machineId: who.machineId } satisfies DaemonAttachment);
                return new Response(null, { status: 101, webSocket: client } as ResponseInit);
            })();
        },
        owns: (ws) => attachment(ws) !== null,
        async message(ws, message) {
            const a = attachment(ws);
            if (!a) return;
            if (typeof message !== 'string') {
                ws.close(1003, 'the daemon protocol is text frames');
                return;
            }
            registry.bind(a.key, state);
            await (await as(machinePrincipal(a.workspaceId, a.machineId), a.key)).socketMessage(message);
        },
        async close(ws) {
            const a = attachment(ws);
            if (!a) return;
            registry.bind(a.key, state);
            // Another daemon socket for the same machine (a redial that replaced this one) keeps it online.
            if (registry.sockets(a.key).some((other) => other !== ws)) return;
            await (await as(machinePrincipal(a.workspaceId, a.machineId), a.key)).socketClosed();
        }
    };
}

/** `machineKey`/`parseMachineKey` re-exported for the worker entry's `machines` lookup. */
export { machineKey, parseMachineKey };
