/**
 * The daemon sockets on the Node host (#988): the Machine actor's
 * `MachineSocketPort` over a `Map` of the open `ws` sockets per machine key.
 *
 * - One daemon per machine: a socket added for a key closes the ones it
 *   replaces (a redial), and the close of a replaced socket does not mark the
 *   machine offline — `remove` answers whether it was the LAST one.
 * - Keepalive (#984): the daemon pings `{"p":1}`; on Cloudflare the runtime
 *   answers without waking the object. Here the host answers it itself
 *   (`pinged`) and never hands it to the actor. `isConnected` counts a socket
 *   whose last ping is younger than `DAEMON_PING_STALE_MS`, or one never
 *   pinged (an older daemon, or one just accepted) — the Cloudflare rule.
 */
import type { MachineSocketPort } from '@agentic/platform';
import { DAEMON_PING_STALE_MS } from '../../web/src/daemon';

/** The slice of a `ws` socket the registry drives. */
export interface DaemonSocketLike {
    send(text: string): void;
    close(code?: number, reason?: string): void;
}

export interface NodeDaemonSockets {
    readonly port: MachineSocketPort;
    /** Register `ws` as `key`'s socket, closing any it replaces. */
    add(key: string, ws: DaemonSocketLike): void;
    /** Forget `ws`; `true` when no socket of `key` is left (the machine is offline). */
    remove(key: string, ws: DaemonSocketLike): boolean;
    /** The daemon's keepalive arrived on `ws`. */
    pinged(key: string, ws: DaemonSocketLike): void;
    /** How many sockets `key` holds (tests). */
    count(key: string): number;
}

export function nodeDaemonSockets(now: () => number = Date.now): NodeDaemonSockets {
    /** key → socket → its last ping (`undefined`: never pinged). */
    const byKey = new Map<string, Map<DaemonSocketLike, number | undefined>>();
    const socketsOf = (key: string): DaemonSocketLike[] => [...(byKey.get(key)?.keys() ?? [])];

    return {
        add(key, ws) {
            const old = socketsOf(key);
            // The replaced sockets leave the map at once, so nothing is sent to them while they close.
            byKey.set(key, new Map([[ws, undefined]]));
            for (const socket of old) {
                try {
                    socket.close(1000, 'replaced by a new daemon connection');
                } catch {
                    // already gone
                }
            }
        },
        remove(key, ws) {
            const sockets = byKey.get(key);
            // A socket a redial replaced is already gone from the map: its close takes nothing offline.
            if (!sockets?.has(ws)) return false;
            sockets.delete(ws);
            if (sockets.size > 0) return false;
            byKey.delete(key);
            return true;
        },
        pinged(key, ws) {
            const sockets = byKey.get(key);
            if (sockets?.has(ws)) sockets.set(ws, now());
        },
        count: (key) => byKey.get(key)?.size ?? 0,
        port: {
            send(key, text) {
                let sent = 0;
                for (const ws of socketsOf(key)) {
                    try {
                        ws.send(text);
                        sent++;
                    } catch {
                        // A socket already gone: its close event follows.
                    }
                }
                return sent > 0;
            },
            isConnected(key) {
                for (const at of byKey.get(key)?.values() ?? []) if (at === undefined || now() - at < DAEMON_PING_STALE_MS) return true;
                return false;
            },
            close(key, code, reason) {
                for (const ws of socketsOf(key)) {
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
