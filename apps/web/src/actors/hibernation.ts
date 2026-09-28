/**
 * Live sockets across a hibernation (#714, OPS-04). A browser's live socket is accepted by its actor's Durable
 * Object with the hibernation API (`createHostDurableObject({ socket })`), so the object may be evicted while the
 * socket stays open. The socket survives; its session — the subscriptions, the watches — does not
 * (signalxjs/actors#171: resume is deliberately not rebuilt from the attachment). `@sigx/actors-cloudflare` tells
 * the client only when the client next SENDS, and a page that only reads never does: a state change that wakes the
 * object would reach nobody, and the page would sit stale behind a socket that looks healthy.
 *
 * So a woken object closes every live socket it did not accept itself, at once, with `1012` — the same word the
 * package uses on a message to an evicted session. The page's transport hears a drop, redials after a short
 * jittered wait (`resilientConnect`) and re-seeds each subscription on the new link: every read answers with its
 * current value, the change that woke the object included, and `fingerprint()` drops the ones that did not move.
 */
import type { DurableObjectStateLike, DurableWebSocketLike } from '@sigx/actors-cloudflare';

/** The tag `createHostDurableObject` accepts its live (object-terminated) sockets under. */
export const LIVE_SOCKET_TAG = 'sigx:socket';

/** `1012 Service Restart`: the session is gone, reconnect. */
export const SESSION_EVICTED_CODE = 1012;

/**
 * Called from the object's constructor, where no session exists yet: every live-tagged socket is an orphan of an
 * earlier instance. Returns them, so the socket handlers can ignore a late frame from one.
 */
export function closeOrphanedLiveSockets(state: Pick<DurableObjectStateLike, 'getWebSockets'>): ReadonlySet<DurableWebSocketLike> {
    const orphans = new Set(state.getWebSockets?.(LIVE_SOCKET_TAG) ?? []);
    for (const ws of orphans) {
        try {
            ws.close(SESSION_EVICTED_CODE, 'session evicted — reconnect');
        } catch {
            // Already closing: the client is on its way back regardless.
        }
    }
    return orphans;
}
