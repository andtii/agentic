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
import { socketTransport } from '@sigx/actors-ws/client';

/** The actor mount's socket prefix (`DEFAULT_SOCKET_PATH`). */
export const SOCKET_PATH = '/_sigx/socket';

/** `{path}/{type}/{key}`, both segments URI-encoded (`parseSocketActorPath`). */
export const actorSocketPath = (type: string, key: string, path = SOCKET_PATH): string => `${path}/${encodeURIComponent(type)}/${encodeURIComponent(key)}`;

/** The browser default: a same-origin `ws(s):` URL for the actor's socket. */
export function browserSocketFor(type: string, key: string): ActorTransport {
    const url = new URL(actorSocketPath(type, key), location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return socketTransport({ url: url.href });
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
