/**
 * This browser's connection to the platform — the first of the four signals
 * of failure distinction (OPS-04): `live` while the actor wire answers,
 * `reconnecting` from the moment it stops (an actor's live socket dropped, a
 * call failed at the network, the browser went offline) until it answers
 * again. One page-global signal: the shell's connection strip, the offline
 * banner and every page's failure card read the same word.
 *
 * `watchTransport` is how the wire reports: it wraps the transport the
 * `actorsPlugin` installs so every stream frame and every answered call say
 * `live`, and a network failure says `reconnecting`. The live sockets report
 * their own opens and drops (`reportingConnect`, `entry-client.tsx`). `installClientConnection`
 * adds the browser's own `online` / `offline` events. Tests drive the signal
 * with `setClientConnection`.
 *
 * The same events wake the live sockets (#714, `wakeSockets`): back online, or back on a visible tab, a socket
 * waiting out its backoff dials at once.
 */
import { signal } from 'sigx';
import type { ActorTransport } from '@sigx/actors/client';
import { wakeSockets, type SocketWake } from '../../actors/live-socket';
import type { ClientConnection } from './failure';

const state = signal({ value: 'live' as ClientConnection });

/** The current word; reactive. */
export const clientConnection = (): ClientConnection => state.value;

export function setClientConnection(next: ClientConnection): void {
    if (state.value !== next) state.value = next;
}

/** A `fetch` that never reached the server: the network, not the platform, said no. */
const isNetworkFailure = (e: unknown): boolean => e instanceof TypeError || (e instanceof Error && /network|fetch|failed to|load failed/i.test(e.message));

/** The transport, reporting: frames and answers say `live`, a network failure says `reconnecting`. */
export function watchTransport(inner: ActorTransport): ActorTransport {
    return {
        name: inner.name,
        async call(symbol, args, init) {
            try {
                const out = await inner.call(symbol, args, init);
                setClientConnection('live');
                return out;
            } catch (e) {
                if (isNetworkFailure(e)) setClientConnection('reconnecting');
                throw e;
            }
        },
        stream(symbol, args, init) {
            const source = inner.stream(symbol, args, init);
            return {
                async *[Symbol.asyncIterator]() {
                    try {
                        for await (const frame of source) {
                            setClientConnection('live');
                            yield frame;
                        }
                    } catch (e) {
                        // The live channel retries with backoff; until a frame arrives again, the reader is reconnecting.
                        if (!init?.signal?.aborted) setClientConnection('reconnecting');
                        throw e;
                    }
                }
            };
        },
        ...(inner.live ? { live: () => inner.live!() } : {}),
        ...(inner.close ? { close: () => inner.close!() } : {})
    };
}

/** Hidden at least this long, a returning tab recycles its open sockets: one may have died silently while it slept. */
export const HIDDEN_REFETCH_MS = 30_000;

/** Where the page hears the tab come back: `document`'s `visibilitychange`. */
export type VisibilitySource = Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;

export interface ClientConnectionOptions {
    /** Default `document`, when there is one. */
    readonly visibility?: VisibilitySource;
    /** Tells the live sockets (default `wakeSockets`). */
    readonly wake?: (wake: SocketWake) => void;
    readonly now?: () => number;
}

/**
 * The browser's own word on the network, and the live sockets woken by it (#714): `online` reconnects at once and
 * re-seeds every live read; a tab made visible again dials any socket waiting out its backoff, and — hidden for
 * `HIDDEN_REFETCH_MS` or more — recycles the open ones too. Returns the uninstaller.
 */
export function installClientConnection(
    target: Pick<Window, 'addEventListener' | 'removeEventListener'> & { navigator?: { onLine?: boolean } } = window,
    { visibility = typeof document === 'undefined' ? undefined : document, wake = wakeSockets, now = Date.now }: ClientConnectionOptions = {}
): () => void {
    const offline = () => setClientConnection('reconnecting');
    const online = () => {
        setClientConnection('live');
        wake({ refetch: true });
    };
    let hiddenAt: number | null = visibility?.visibilityState === 'hidden' ? now() : null;
    const visible = () => {
        if (!visibility) return;
        if (visibility.visibilityState === 'hidden') {
            hiddenAt ??= now();
            return;
        }
        const away = hiddenAt === null ? 0 : now() - hiddenAt;
        hiddenAt = null;
        wake({ refetch: away >= HIDDEN_REFETCH_MS });
    };
    target.addEventListener('offline', offline);
    target.addEventListener('online', online);
    visibility?.addEventListener('visibilitychange', visible);
    if (target.navigator?.onLine === false) offline();
    return () => {
        target.removeEventListener('offline', offline);
        target.removeEventListener('online', online);
        visibility?.removeEventListener('visibilitychange', visible);
    };
}
