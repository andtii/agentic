/**
 * Live reads on the object-terminated, hibernatable socket (#712, #717).
 *
 * The Worker forwards `/_sigx/socket/{type}/{key}` to that actor's Durable
 * Object, which accepts it with the hibernation API (`actors.app.ts`,
 * `createHostDurableObject({ socket })`). An idle socket costs nothing; the
 * NDJSON `$live` stream `fetchTransport` would hold open instead keeps its
 * object awake for as long as the tab is open (#351), so pages never use it
 * (#715, `page-transport.ts`).
 *
 * The `socketTransport()` from `@sigx/actors-ws` is ONE multiplexed link and its
 * `connect` seam is not told which actor it is for, so this router keeps one
 * `socketTransport` per actor, keyed by the subscription's `type`/`key`,
 * opened on the first subscription. When the last one ends the socket lingers
 * for `LINGER_MS` before it closes (#1117): a page that unmounts and the next
 * one that reads the same actor share the open socket instead of redialling
 * it. Calls stay on `calls` (POSTs): one-shot calls do not keep an object awake.
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
 * How long a dropped socket may stay down before the pill says `reconnecting` (#1024). A woken Durable Object hands
 * back every live socket with `1012` (#714), and the page redials within the first backoff window plus one dial.
 * That is a handover, not a lost connection. The browser's own `offline` event still reports at once.
 */
export const DROP_GRACE_MS = 5_000;

/**
 * How long a socket with no subscribers stays open before it closes (#1117). Page-owned reads unmount on every route
 * change and the next page often reads the same actors; an idle socket to a hibernating object costs nothing.
 */
export const LINGER_MS = 10_000;

/**
 * The link between `liveOverSockets` and one actor's socket while it lingers (#1117). The router sets `idle` while the
 * socket has no subscribers. A close nobody asked for while idle is then no drop for the pill (nothing redials an idle
 * socket, so nothing would ever report it open again); it is told to `onIdleDrop` instead, which retires the socket.
 */
export interface SocketLinger {
    idle: boolean;
    onIdleDrop?: () => void;
}

/** An actor's socket transport that can linger: `browserSocketFor` returns one. */
export interface LingeringTransport extends ActorTransport {
    readonly linger?: SocketLinger;
}

export interface ReportingOptions {
    /** How long a drop may wait for a reopen before it is reported. Default `0`: at once. */
    readonly graceMs?: number;
    /** A close nobody asked for while `linger.idle` is not a drop: it goes to `linger.onIdleDrop` (#1117). */
    readonly linger?: SocketLinger;
    /** Timers; injected by tests. */
    readonly setTimer?: (run: () => void, ms: number) => unknown;
    readonly clearTimer?: (handle: unknown) => void;
}

/**
 * `connect`, reporting: an open says so, and so does a close nobody asked for.
 * A close the transport made itself (the actor's last subscription ended, the
 * app unmounted) is not a drop. A dial that never opened is one: the
 * transport retries it with backoff, so the reader is reconnecting.
 *
 * With `graceMs`, a drop is reported only when the actor's socket has not
 * reopened by then (#1024). There is one pending report per `reportingConnect`,
 * shared by every redial of that actor's transport. An open, or a close the
 * transport made itself, cancels it.
 */
export function reportingConnect(connect: SocketConnect, report: SocketReport, options: ReportingOptions = {}): SocketConnect {
    const { graceMs = 0, linger } = options;
    const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
    const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    let pending: unknown = null;
    const cancel = (): void => {
        if (pending === null) return;
        clearTimer(pending);
        pending = null;
    };
    const drop = (): void => {
        if (graceMs <= 0) return report.onDrop?.();
        pending ??= setTimer(() => {
            pending = null;
            report.onDrop?.();
        }, graceMs);
    };
    return (handlers) => {
        let closing = false;
        const link = connect({
            onOpen() {
                cancel();
                report.onOpen?.();
                handlers.onOpen();
            },
            onMessage: (message) => handlers.onMessage(message),
            onClose() {
                if (!closing) {
                    if (linger?.idle) {
                        cancel();
                        linger.onIdleDrop?.();
                    } else drop();
                }
                handlers.onClose();
            }
        });
        return {
            send: (message) => link.send(message),
            close() {
                closing = true;
                cancel();
                link.close();
            }
        };
    };
}

/** Reconnect tuning (OPS-04, #714). */
export interface BackoffOptions {
    /** The first retry's window. Default 500 ms. */
    readonly baseMs?: number;
    /** The ceiling a retry never waits past. Default 30 s. */
    readonly capMs?: number;
    /** `[0, 1)`; default `Math.random`. Injected by tests. */
    readonly random?: () => number;
}

export const BACKOFF_BASE_MS = 500;
export const BACKOFF_CAP_MS = 30_000;

/**
 * How long retry `attempt` (0-based) waits: exponential, capped, with "equal jitter" — half the window fixed, half
 * random — so a fleet of tabs dropped by one deploy does not redial in lock-step, and no retry is ever instant.
 */
export function backoffDelay(attempt: number, { baseMs = BACKOFF_BASE_MS, capMs = BACKOFF_CAP_MS, random = Math.random }: BackoffOptions = {}): number {
    const window = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
    return Math.round(window / 2 + random() * (window / 2));
}

/** What a wake asks of every actor socket: dial a waiting retry now, and with `refetch`, recycle an open link too. */
export interface SocketWake {
    /** Also close and redial an open link, so its subscriptions re-seed from a fresh snapshot. */
    readonly refetch: boolean;
}

type Waker = (wake: SocketWake) => void;

/** The page's actor sockets, told by `wakeSockets` (the browser's `online` / `visibilitychange`, `installClientConnection`). */
const wakers = new Set<Waker>();

/** Wake every actor socket of this page. */
export function wakeSockets(wake: SocketWake): void {
    // A snapshot: a woken socket leaves the set, and its redial may join it again.
    for (const w of Array.from(wakers)) w(wake);
}

export interface ResilientConnectOptions extends BackoffOptions {
    /** Timers; injected by tests. */
    readonly setTimer?: (run: () => void, ms: number) => unknown;
    readonly clearTimer?: (handle: unknown) => void;
    /** Where this connection hears wakes; default the page-global set `wakeSockets` tells. */
    readonly wakers?: Set<Waker>;
}

/**
 * `connect`, with the reconnect policy the page owns (OPS-04, #714): `socketTransport` redials after every drop and
 * re-seeds its subscriptions on the new link (each re-sent `{i,sub}` is answered with the read's current value — the
 * snapshot — and `fingerprint()` drops the ones that did not change), but its own backoff has no jitter and no way to
 * be cut short. So it is switched off (`retryMs: 0`) and this seam decides when each attempt dials:
 *
 * - the first dial is immediate; a dial after an open link dropped waits `backoffDelay(0)`, and each failed attempt
 *   after it `backoffDelay(n)` — exponential, capped, jittered;
 * - a wake (`wakeSockets`) dials a waiting attempt now; a wake with `refetch` also closes an open link and redials it
 *   at once, so a socket that died silently while the laptop slept is replaced and the page re-seeds.
 */
export function resilientConnect(dial: SocketConnect, options: ResilientConnectOptions = {}): SocketConnect {
    const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
    const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    const bus = options.wakers ?? wakers;
    /** Failed attempts since the last open; `-1` = the next dial is immediate (first dial, or a recycle). */
    let failures = -1;
    return (handlers) => {
        let link: ReturnType<SocketConnect> | null = null;
        let timer: unknown = null;
        let opened = false;
        let ended = false;
        const end = (): void => {
            bus.delete(waker);
            if (ended) return;
            ended = true;
            handlers.onClose();
        };
        const go = (): void => {
            timer = null;
            if (ended) return;
            try {
                // An attempt this seam already ended (closed, recycled) is retired: its late events are ignored.
                link = dial({
                    onOpen() {
                        if (ended) return;
                        opened = true;
                        failures = 0;
                        handlers.onOpen();
                    },
                    onMessage(message) {
                        if (!ended) handlers.onMessage(message);
                    },
                    onClose() {
                        if (ended) return;
                        link = null;
                        failures = opened ? 0 : failures + 1;
                        end();
                    }
                });
            } catch {
                // A dial that throws (a malformed URL, no `WebSocket`) is a failed attempt, retried like one.
                failures++;
                end();
            }
        };
        const waker: Waker = ({ refetch }) => {
            if (ended) return;
            if (timer !== null) {
                clearTimer(timer);
                go();
            } else if (refetch && opened && link) {
                // Ended at once, not on the close event: a socket that died silently can take long to finish closing.
                const retired = link;
                link = null;
                failures = -1;
                end();
                retired.close();
            }
        };
        bus.add(waker);
        const wait = failures < 0 ? 0 : backoffDelay(failures, options);
        if (wait > 0) timer = setTimer(go, wait);
        else go();
        return {
            send: (message) => link?.send(message),
            close() {
                if (timer !== null) {
                    clearTimer(timer);
                    timer = null;
                }
                const retired = link;
                link = null;
                end();
                retired?.close();
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

/**
 * The browser default: a same-origin `ws(s):` URL for the actor's socket, its opens and drops told to `report`. It
 * carries the `linger` link `liveOverSockets` sets while the socket has no subscribers (#1117).
 */
export function browserSocketFor(type: string, key: string, report: SocketReport = {}): LingeringTransport {
    const url = new URL(actorSocketPath(type, key), location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    // The transport's own backoff is off: `resilientConnect` paces the redials (jittered, cut short by a wake). A drop
    // that a redial recovers from within `DROP_GRACE_MS` is a handover, and the pill does not hear about it (#1024).
    const linger: SocketLinger = { idle: false };
    const connect = reportingConnect(resilientConnect(webSocketConnect(url.href)), report, { graceMs: DROP_GRACE_MS, linger });
    return Object.assign(socketTransport({ connect, retryMs: 0 }), { linger });
}

export interface LiveOverSocketsOptions {
    /** Calls and streams — the existing `fetchTransport`. */
    readonly calls: ActorTransport;
    /** One actor's socket transport. Default `browserSocketFor`. A `LingeringTransport` also hears when it idles. */
    readonly socketFor?: (type: string, key: string) => LingeringTransport;
    /** How long a socket with no subscribers stays open (#1117). Default `LINGER_MS`; `0` closes it with the last. */
    readonly lingerMs?: number;
    /** Timers; injected by tests. */
    readonly setTimer?: (run: () => void, ms: number) => unknown;
    readonly clearTimer?: (handle: unknown) => void;
}

interface ActorSocket {
    readonly transport: LingeringTransport;
    readonly channel: ActorLiveChannel;
    subscribers: number;
    /** The pending close while the socket has no subscribers. */
    linger: unknown;
}

export function liveOverSockets({ calls, socketFor = browserSocketFor, lingerMs = LINGER_MS, ...options }: LiveOverSocketsOptions): ActorTransport {
    const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
    const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    const sockets = new Map<string, ActorSocket>();
    const stopLinger = (socket: ActorSocket): void => {
        if (socket.linger !== null) clearTimer(socket.linger);
        socket.linger = null;
        if (socket.transport.linger) socket.transport.linger.idle = false;
    };
    /** Close a socket and forget it, unless a newer socket already holds its place. */
    const retire = (id: string, socket: ActorSocket): void => {
        stopLinger(socket);
        if (sockets.get(id) === socket) sockets.delete(id);
        void socket.transport.close?.();
    };
    const channel: ActorLiveChannel = {
        subscribe(sub, onValue, onError) {
            const id = `${sub.type}\u0000${sub.key}`;
            let socket = sockets.get(id);
            if (!socket) {
                const transport = socketFor(sub.type, sub.key);
                const live = transport.live?.();
                if (!live) throw new Error(`transport ${transport.name} has no live channel`);
                const created: ActorSocket = { transport, channel: live, subscribers: 0, linger: null };
                // A lingering socket that closes on its own is dropped; the next subscription dials a fresh one.
                if (transport.linger) transport.linger.onIdleDrop = () => void (created.subscribers === 0 && retire(id, created));
                socket = created;
                sockets.set(id, socket);
            }
            // A subscription within the linger reuses the open socket.
            stopLinger(socket);
            socket.subscribers++;
            const unsubscribe = socket.channel.subscribe(sub, onValue, onError);
            let done = false;
            return () => {
                if (done) return;
                done = true;
                unsubscribe();
                if (--socket.subscribers > 0 || sockets.get(id) !== socket) return;
                if (lingerMs <= 0) return retire(id, socket);
                if (socket.transport.linger) socket.transport.linger.idle = true;
                socket.linger = setTimer(() => {
                    socket.linger = null;
                    retire(id, socket);
                }, lingerMs);
            };
        }
    };
    return {
        name: `${calls.name}+socket`,
        call: (symbol, args, init) => calls.call(symbol, args, init),
        stream: (symbol, args, init) => calls.stream(symbol, args, init),
        live: () => channel,
        close() {
            for (const socket of sockets.values()) {
                stopLinger(socket);
                void socket.transport.close?.();
            }
            sockets.clear();
            return calls.close?.();
        }
    };
}
