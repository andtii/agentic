/**
 * A live socket lingers after its last subscriber (#1117): a subscription for the same actor within `LINGER_MS`
 * reuses the open socket, the socket closes once the linger runs out, and a lingering socket that closes on its own is
 * dropped — without telling the connection pill — so the next subscription dials a fresh one.
 */
import type { ActorSubscription, ActorTransport } from '@sigx/actors/client';
import { browserSocketFor, DROP_GRACE_MS, LINGER_MS, liveOverSockets } from '../src/actors/live-socket';

/** A stand-in for the browser's `WebSocket`: every construction is recorded, and the test opens and drops them. */
class FakeWebSocket {
    static readonly made: FakeWebSocket[] = [];
    readonly sent: string[] = [];
    closed = false;
    private readonly listeners = new Map<string, ((e: { data?: unknown }) => void)[]>();
    constructor(readonly url: string) {
        FakeWebSocket.made.push(this);
    }
    addEventListener(type: string, listener: (e: { data?: unknown }) => void): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    private emit(type: string, e: { data?: unknown } = {}): void {
        for (const l of this.listeners.get(type) ?? []) l(e);
    }
    send(message: string): void {
        this.sent.push(message);
    }
    open(): void {
        this.emit('open');
    }
    /** Closed by the page. */
    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.emit('close');
    }
    /** Closed by the other end, or an error: nobody on the page asked for it. */
    drop(): void {
        this.close();
    }
}

const calls: ActorTransport = { name: 'fetch', call: async () => undefined, stream: () => ({ async *[Symbol.asyncIterator]() {} }) };
const sub: ActorSubscription = { type: 'Chat', key: 'ws:c1', method: 'get' };
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('liveOverSockets: a socket lingers after its last subscriber (#1117)', () => {
    let report: { onOpen: ReturnType<typeof vi.fn<() => void>>; onDrop: ReturnType<typeof vi.fn<() => void>> };
    let transport: ActorTransport;
    let socketsMade: number;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal('WebSocket', FakeWebSocket);
        FakeWebSocket.made.length = 0;
        report = { onOpen: vi.fn<() => void>(), onDrop: vi.fn<() => void>() };
        socketsMade = 0;
        transport = liveOverSockets({ calls, socketFor: (type, key) => (socketsMade++, browserSocketFor(type, key, report)) });
    });

    afterEach(async () => {
        await transport.close?.();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    /** Subscribe and let the socket open. */
    async function subscribe(): Promise<() => void> {
        const unsubscribe = transport.live!().subscribe(sub, () => {});
        await flush();
        const ws = FakeWebSocket.made[FakeWebSocket.made.length - 1]!;
        if (!ws.closed) ws.open();
        await flush();
        return unsubscribe;
    }

    it('unsubscribe, then resubscribe within the linger: exactly one WebSocket', async () => {
        const first = await subscribe();
        expect(FakeWebSocket.made).toHaveLength(1);
        first();
        await vi.advanceTimersByTimeAsync(LINGER_MS - 1);
        expect(FakeWebSocket.made[0]!.closed).toBe(false);

        const second = await subscribe();
        expect(FakeWebSocket.made).toHaveLength(1);
        expect(socketsMade).toBe(1);
        expect(FakeWebSocket.made[0]!.closed).toBe(false);
        // The resubscription cancelled the close: the socket outlives the first linger.
        await vi.advanceTimersByTimeAsync(LINGER_MS);
        expect(FakeWebSocket.made[0]!.closed).toBe(false);
        second();
    });

    it('unsubscribe and wait out the linger: the socket is closed, and the next subscription dials anew', async () => {
        (await subscribe())();
        await vi.advanceTimersByTimeAsync(LINGER_MS);
        expect(FakeWebSocket.made[0]!.closed).toBe(true);
        expect(report.onDrop).not.toHaveBeenCalled();

        await subscribe();
        expect(FakeWebSocket.made).toHaveLength(2);
    });

    it('a socket that drops while lingering is removed without a pill drop; the next subscription dials a fresh one', async () => {
        (await subscribe())();
        FakeWebSocket.made[0]!.drop();
        await vi.advanceTimersByTimeAsync(DROP_GRACE_MS + LINGER_MS);
        expect(report.onDrop).not.toHaveBeenCalled();
        expect(FakeWebSocket.made).toHaveLength(1);

        await subscribe();
        expect(FakeWebSocket.made).toHaveLength(2);
        expect(FakeWebSocket.made[1]!.closed).toBe(false);
        expect(socketsMade).toBe(2);
    });

    it('a drop while subscribed is still reported and redialled', async () => {
        await subscribe();
        FakeWebSocket.made[0]!.drop();
        await vi.advanceTimersByTimeAsync(DROP_GRACE_MS);
        expect(report.onDrop).toHaveBeenCalledTimes(1);
        expect(FakeWebSocket.made.length).toBeGreaterThan(1);
    });

    it('closing the transport closes a lingering socket at once', async () => {
        (await subscribe())();
        await transport.close?.();
        expect(FakeWebSocket.made[0]!.closed).toBe(true);
    });
});
