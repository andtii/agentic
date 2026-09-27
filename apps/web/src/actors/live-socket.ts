/**
 * Live reads on the object-terminated, hibernatable socket (#712, #717).
 *
 * The Worker forwards `/_sigx/socket/{type}/{key}` to that actor's Durable
 * Object, which accepts it with the hibernation API (`actors.app.ts`,
 * `createHostDurableObject({ socket })`). An idle socket costs nothing; the
 * NDJSON `$live` stream that `fetchTransport` holds open keeps its object
 * awake for as long as the tab is open (#351).
 *
 * The `socketTransport()` from `@sigx/actors-ws` is ONE multiplexed link and its
 * `connect` seam is not told which actor it is for, so this router keeps one
 * `socketTransport` per actor, keyed by the subscription's `type`/`key`,
 * opened on the first subscription and closed with the last. Calls stay on
 * `calls` (POSTs): one-shot calls do not keep an object awake.
 */
import type { ActorLiveChannel, ActorTransport } from '@sigx/actors/client';
import { socketTransport, type SocketTransportOptions } from '@sigx/actors-ws/client';

/** The actor mount's socket prefix (`DEFAULT_SOCKET_PATH`). */
export const SOCKET_PATH = '/_sigx/socket';

/** `{path}/{type}/{key}`, both segments URI-encoded (`parseSocketActorPath`). */
export const actorSocketPath = (type: string, key: string, path = SOCKET_PATH): string => `${path}/${encodeURIComponent(type)}/${encodeURIComponent(key)}`;

/** One connection attempt: `socketTransport`'s `connect` seam. */
export type SocketConnect = NonNullable<SocketTransportOptions['connect']>;

/** What the connection pill hears from a socket (OPS-04): it opened, or it dropped without being asked to. */
export interface SocketReport {
    onOpen?(): void;
    onDrop?(): void;
}

/**
 * `connect`, reporting: an open says so, and so does a close nobody asked for.
 * A close the transport made itself (the actor's last subscription ended, the
 * app unmounted) is not a drop. A dial that never opened is one: the
 * transport retries it with backoff, so the reader is reconnecting.
 */
export function reportingConnect(connect: SocketConnect, report: SocketReport): SocketConnect {
    return (handlers) => {
        let closing = false;
        const link = connect({
            onOpen() {
                report.onOpen?.();
                handlers.onOpen();
            },
            onMessage: (message) => handlers.onMessage(message),
            onClose() {
                if (!closing) report.onDrop?.();
                handlers.onClose();
            }
        });
        return {
            send: (message) => link.send(message),
            close() {
                closing = true;
                link.close();
            }
        };
    };
}

/** Dial `url` on the global `WebSocket`, as `socketTransport({ url })` does. */
const webSocketConnect =
    (url: string): SocketConnect =>
    (handlers) => {
        const ws = new WebSocket(url);
        ws.addEventListener('open', () => handlers.onOpen());
        ws.addEventListener('message', (e) => {
            if (typeof e.data === 'string') handlers.onMessage(e.data);
        });
        ws.addEventListener('close', () => handlers.onClose());
        return { send: (message) => ws.send(message), close: () => ws.close() };
    };

/** The browser default: a same-origin `ws(s):` URL for the actor's socket, its opens and drops told to `report`. */
export function browserSocketFor(type: string, key: string, report: SocketReport = {}): ActorTransport {
    const url = new URL(actorSocketPath(type, key), location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return socketTransport({ connect: reportingConnect(webSocketConnect(url.href), report) });
}

export interface LiveOverSocketsOptions {
    /** Calls and streams — the existing `fetchTransport`. */
    readonly calls: ActorTransport;
    /** One actor's socket transport. Default `browserSocketFor`. */
    readonly socketFor?: (type: string, key: string) => ActorTransport;
}

interface ActorSocket {
    readonly transport: ActorTransport;
    readonly channel: ActorLiveChannel;
    subscribers: number;
}

export function liveOverSockets({ calls, socketFor = browserSocketFor }: LiveOverSocketsOptions): ActorTransport {
    const sockets = new Map<string, ActorSocket>();
    const channel: ActorLiveChannel = {
        subscribe(sub, onValue, onError) {
            const id = `${sub.type}\u0000${sub.key}`;
            let socket = sockets.get(id);
            if (!socket) {
                const transport = socketFor(sub.type, sub.key);
                const live = transport.live?.();
                if (!live) throw new Error(`transport ${transport.name} has no live channel`);
                socket = { transport, channel: live, subscribers: 0 };
                sockets.set(id, socket);
            }
            socket.subscribers++;
            const unsubscribe = socket.channel.subscribe(sub, onValue, onError);
            let done = false;
            return () => {
                if (done) return;
                done = true;
                unsubscribe();
                if (--socket.subscribers === 0 && sockets.get(id) === socket) {
                    sockets.delete(id);
                    void socket.transport.close?.();
                }
            };
        }
    };
    return {
        name: `${calls.name}+socket`,
        call: (symbol, args, init) => calls.call(symbol, args, init),
        stream: (symbol, args, init) => calls.stream(symbol, args, init),
        live: () => channel,
        close() {
            for (const socket of sockets.values()) void socket.transport.close?.();
            sockets.clear();
            return calls.close?.();
        }
    };
}
