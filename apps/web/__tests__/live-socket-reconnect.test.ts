/**
 * Live sockets reconnect and resume (#714, OPS-04): the jittered, capped backoff; `resilientConnect` pacing
 * `socketTransport`'s redials and cut short by a wake; a dropped socket's subscriptions re-seeded on the new link;
 * and the browser's `online` / `visibilitychange` waking the sockets through `installClientConnection`.
 */
import type { SocketHandlers } from '@sigx/actors-ws/client';
import { socketTransport } from '@sigx/actors-ws/client';
import { BACKOFF_BASE_MS, BACKOFF_CAP_MS, backoffDelay, resilientConnect, wakeSockets, type SocketWake } from '../src/actors/live-socket';
import { HIDDEN_REFETCH_MS, installClientConnection } from '../src/components/status/client';

/** A dial whose connections the test drives by hand. */
function fakeDial() {
    const links: { handlers: SocketHandlers; sent: string[]; closed: boolean }[] = [];
    const dial = (handlers: SocketHandlers) => {
        const link = { handlers, sent: [] as string[], closed: false };
        links.push(link);
        return {
            send: (m: string) => void link.sent.push(m),
            close() {
                if (link.closed) return;
                link.closed = true;
                handlers.onClose();
            }
        };
    };
    return { dial, links, last: () => links[links.length - 1]! };
}

/** Hand-run timers: `due()` lists the waits asked for, `fire()` runs them. */
function fakeTimers() {
    const pending = new Map<number, { run: () => void; ms: number }>();
    let next = 1;
    return {
        setTimer: (run: () => void, ms: number) => (pending.set(next, { run, ms }), next++),
        clearTimer: (h: unknown) => void pending.delete(h as number),
        due: () => [...pending.values()].map((t) => t.ms),
        fire() {
            const all = [...pending.values()];
            pending.clear();
            for (const t of all) t.run();
        }
    };
}

const noop: SocketHandlers = { onOpen: () => {}, onMessage: () => {}, onClose: () => {} };

describe('backoffDelay', () => {
    it('doubles per attempt from the base, up to the cap', () => {
        const mid = { random: () => 1 - Number.EPSILON };
        expect(backoffDelay(0, mid)).toBe(BACKOFF_BASE_MS);
        expect(backoffDelay(1, mid)).toBe(BACKOFF_BASE_MS * 2);
        expect(backoffDelay(3, mid)).toBe(BACKOFF_BASE_MS * 8);
        expect(backoffDelay(30, mid)).toBe(BACKOFF_CAP_MS);
    });

    it('jitters inside the upper half of the window, never instant', () => {
        expect(backoffDelay(2, { baseMs: 100, random: () => 0 })).toBe(200);
        expect(backoffDelay(2, { baseMs: 100, random: () => 0.5 })).toBe(300);
        const seen = new Set(Array.from({ length: 20 }, () => backoffDelay(4, { baseMs: 100 })));
        for (const d of seen) {
            expect(d).toBeGreaterThanOrEqual(800);
            expect(d).toBeLessThanOrEqual(1600);
        }
        expect(seen.size).toBeGreaterThan(1);
    });
});

describe('resilientConnect', () => {
    const opts = (timers: ReturnType<typeof fakeTimers>, wakers = new Set<(w: SocketWake) => void>()) => ({ ...timers, wakers, baseMs: 100, capMs: 1000, random: () => 0 });

    it('dials the first attempt at once, and backs off after each failure', () => {
        const { dial, links } = fakeDial();
        const timers = fakeTimers();
        const connect = resilientConnect(dial, opts(timers));
        connect(noop);
        expect(links).toHaveLength(1);
        links[0]!.handlers.onClose(); // never opened
        connect(noop);
        expect(links).toHaveLength(1);
        expect(timers.due()).toEqual([50]);
        timers.fire();
        expect(links).toHaveLength(2);
        links[1]!.handlers.onClose();
        connect(noop);
        expect(timers.due()).toEqual([100]);
    });

    it('waits a jittered moment after an open link drops, and resets the ladder on open', () => {
        const { dial, links } = fakeDial();
        const timers = fakeTimers();
        const connect = resilientConnect(dial, opts(timers));
        connect(noop);
        links[0]!.handlers.onClose();
        connect(noop);
        timers.fire();
        links[1]!.handlers.onOpen();
        links[1]!.handlers.onClose(); // dropped after opening
        connect(noop);
        expect(timers.due()).toEqual([50]);
    });

    it('a wake dials a waiting attempt now', () => {
        const { dial, links } = fakeDial();
        const timers = fakeTimers();
        const wakers = new Set<(w: SocketWake) => void>();
        const connect = resilientConnect(dial, opts(timers, wakers));
        connect(noop);
        links[0]!.handlers.onClose();
        connect(noop);
        expect(links).toHaveLength(1);
        for (const w of wakers) w({ refetch: false });
        expect(links).toHaveLength(2);
        expect(timers.due()).toEqual([]);
    });

    it('a refetch wake recycles an open link, and the redial is immediate', () => {
        const { dial, links } = fakeDial();
        const timers = fakeTimers();
        const wakers = new Set<(w: SocketWake) => void>();
        const connect = resilientConnect(dial, opts(timers, wakers));
        const closes: string[] = [];
        connect({ ...noop, onClose: () => closes.push('closed') });
        links[0]!.handlers.onOpen();
        for (const w of wakers) w({ refetch: false });
        expect(links[0]!.closed).toBe(false);
        for (const w of wakers) w({ refetch: true });
        expect(links[0]!.closed).toBe(true);
        expect(closes).toEqual(['closed']);
        connect(noop);
        expect(links).toHaveLength(2);
    });

    it('a recycled link that never finishes closing is retired at once, its late events ignored', () => {
        const links: SocketHandlers[] = [];
        const dial = (h: SocketHandlers) => (links.push(h), { send: () => {}, close: () => {} }); // a dead peer: no close event
        const wakers = new Set<(w: SocketWake) => void>();
        const connect = resilientConnect(dial, opts(fakeTimers(), wakers));
        const events: string[] = [];
        connect({ onOpen: () => events.push('open'), onMessage: (m) => events.push(m), onClose: () => events.push('closed') });
        links[0]!.onOpen();
        for (const w of wakers) w({ refetch: true });
        expect(events).toEqual(['open', 'closed']);
        links[0]!.onMessage('late');
        links[0]!.onClose();
        expect(events).toEqual(['open', 'closed']);
        connect(noop);
        expect(links).toHaveLength(2);
    });

    it('closing a waiting attempt cancels its timer and reports the close', () => {
        const { dial, links } = fakeDial();
        const timers = fakeTimers();
        const wakers = new Set<(w: SocketWake) => void>();
        const connect = resilientConnect(dial, opts(timers, wakers));
        connect(noop);
        links[0]!.handlers.onClose();
        const closes: string[] = [];
        connect({ ...noop, onClose: () => closes.push('closed') }).close();
        expect(timers.due()).toEqual([]);
        expect(closes).toEqual(['closed']);
        expect(wakers.size).toBe(0);
    });

    it('a dial that throws is a failed attempt', () => {
        const timers = fakeTimers();
        const closes: string[] = [];
        const connect = resilientConnect(() => {
            throw new Error('no WebSocket');
        }, opts(timers));
        connect({ ...noop, onClose: () => closes.push('closed') });
        expect(closes).toEqual(['closed']);
        connect(noop);
        expect(timers.due()).toEqual([50]);
    });
});

describe('resubscribe after a drop (socketTransport over resilientConnect)', () => {
    const flush = () => new Promise((r) => setTimeout(r, 0));
    const subsOf = (sent: string[]) => sent.map((m) => JSON.parse(m) as { i: number; sub?: { t: string; k: string; m: string } }).filter((m) => m.sub);

    it('re-sends every subscription on the new link, and a snapshot that did not change renders nothing', async () => {
        const { dial, links, last } = fakeDial();
        const wakers = new Set<(w: SocketWake) => void>();
        const transport = socketTransport({ connect: resilientConnect(dial, { wakers, baseMs: 60_000 }), retryMs: 0 });
        const values: unknown[] = [];
        const stop = transport.live!().subscribe({ type: 'Chat', key: 'ws:chat:1', method: 'get' }, (v) => values.push(v));
        await flush();
        last().handlers.onOpen();
        await flush();
        const [first] = subsOf(last().sent);
        expect(first?.sub).toMatchObject({ t: 'Chat', k: 'ws:chat:1', m: 'get' });
        last().handlers.onMessage(JSON.stringify({ i: first!.i, v: { n: 1 } }));
        expect(values).toEqual([{ n: 1 }]);

        // The socket drops; the redial waits out its backoff until the tab wakes it.
        last().handlers.onClose();
        await flush();
        expect(links).toHaveLength(1);
        for (const w of wakers) w({ refetch: false });
        await flush();
        expect(links).toHaveLength(2);
        last().handlers.onOpen();
        await flush();
        const [again] = subsOf(last().sent);
        expect(again?.sub).toEqual(first!.sub);
        expect(again!.i).not.toBe(first!.i);

        // The snapshot on the new link: the same value is suppressed, a changed one delivered.
        last().handlers.onMessage(JSON.stringify({ i: again!.i, v: { n: 1 } }));
        expect(values).toEqual([{ n: 1 }]);
        last().handlers.onMessage(JSON.stringify({ i: again!.i, v: { n: 2 } }));
        expect(values).toEqual([{ n: 1 }, { n: 2 }]);

        stop();
        await transport.close?.();
    });

    it('wakeSockets reaches the page-global sockets', async () => {
        const { dial, links, last } = fakeDial();
        const transport = socketTransport({ connect: resilientConnect(dial, { baseMs: 60_000 }), retryMs: 0 });
        const stop = transport.live!().subscribe({ type: 'Chat', key: 'k', method: 'get' }, () => {});
        await flush();
        last().handlers.onOpen();
        await flush();
        wakeSockets({ refetch: true });
        await flush();
        expect(links[0]!.closed).toBe(true);
        expect(links).toHaveLength(2);
        stop();
        await transport.close?.();
    });
});

describe('installClientConnection wakes the live sockets', () => {
    function fakeTargets(hidden = false) {
        const win = new EventTarget() as EventTarget & { navigator?: { onLine?: boolean } };
        const doc = Object.assign(new EventTarget(), { visibilityState: (hidden ? 'hidden' : 'visible') as DocumentVisibilityState });
        const show = (state: DocumentVisibilityState) => {
            doc.visibilityState = state;
            doc.dispatchEvent(new Event('visibilitychange'));
        };
        return { win, doc, show };
    }

    it('online reconnects and re-seeds at once', () => {
        const { win, doc } = fakeTargets();
        const woke: SocketWake[] = [];
        const off = installClientConnection(win as never, { visibility: doc as never, wake: (w) => woke.push(w) });
        win.dispatchEvent(new Event('online'));
        expect(woke).toEqual([{ refetch: true }]);
        off();
        win.dispatchEvent(new Event('online'));
        expect(woke).toHaveLength(1);
    });

    it('a tab back after a short hide dials waiting sockets; after a long one it re-seeds the open ones too', () => {
        const { win, doc, show } = fakeTargets();
        let t = 1_000;
        const woke: SocketWake[] = [];
        const off = installClientConnection(win as never, { visibility: doc as never, wake: (w) => woke.push(w), now: () => t });
        show('hidden');
        t += 5_000;
        show('visible');
        show('hidden');
        t += HIDDEN_REFETCH_MS;
        show('visible');
        expect(woke).toEqual([{ refetch: false }, { refetch: true }]);
        off();
    });

    it('a page loaded hidden counts its hidden time from load', () => {
        const { win, doc, show } = fakeTargets(true);
        let t = 0;
        const woke: SocketWake[] = [];
        installClientConnection(win as never, { visibility: doc as never, wake: (w) => woke.push(w), now: () => t })();
        const off = installClientConnection(win as never, { visibility: doc as never, wake: (w) => woke.push(w), now: () => t });
        t += HIDDEN_REFETCH_MS + 1;
        show('visible');
        expect(woke).toEqual([{ refetch: true }]);
        off();
    });
});
