import type { ActorSubscription, ActorTransport } from '@sigx/actors/client';
import type { SocketHandlers } from '@sigx/actors-ws/client';
import { actorSocketPath, liveOverSockets, reportingConnect } from '../src/actors/live-socket';

/** A fake socket transport per actor, counting subscriptions and closes. */
function fakeSockets() {
    const opened: string[] = [];
    const closed: string[] = [];
    const socketFor = (type: string, key: string): ActorTransport => {
        opened.push(`${type}/${key}`);
        return {
            name: 'fake-socket',
            call: () => Promise.reject(new Error('no calls on the socket')),
            stream: () => {
                throw new Error('no streams on the socket');
            },
            live: () => ({ subscribe: (_sub, onValue) => (onValue(`${type}/${key}`), () => {}) }),
            close: () => void closed.push(`${type}/${key}`)
        };
    };
    return { opened, closed, socketFor };
}

const calls: ActorTransport = { name: 'fetch', call: async (symbol) => `called ${symbol}`, stream: () => ({ async *[Symbol.asyncIterator]() {} }) };
const sub = (type: string, key: string, method = 'get'): ActorSubscription => ({ type, key, method });

describe('liveOverSockets', () => {
    it('opens one socket per actor, shared by its subscriptions, closed with the last', () => {
        const { opened, closed, socketFor } = fakeSockets();
        const live = liveOverSockets({ calls, socketFor }).live!();
        const values: unknown[] = [];

        const a1 = live.subscribe(sub('Chat', 'ws:c1'), (v) => values.push(v));
        const a2 = live.subscribe(sub('Chat', 'ws:c1', 'history'), (v) => values.push(v));
        const b = live.subscribe(sub('Workspace', 'ws'), (v) => values.push(v));
        expect(opened).toEqual(['Chat/ws:c1', 'Workspace/ws']);
        expect(values).toEqual(['Chat/ws:c1', 'Chat/ws:c1', 'Workspace/ws']);

        a1();
        a1();
        expect(closed).toEqual([]);
        a2();
        expect(closed).toEqual(['Chat/ws:c1']);

        live.subscribe(sub('Chat', 'ws:c1'), () => {});
        expect(opened).toEqual(['Chat/ws:c1', 'Workspace/ws', 'Chat/ws:c1']);
        b();
        expect(closed).toEqual(['Chat/ws:c1', 'Workspace/ws']);
    });

    it('keeps calls on the calls transport and closes every socket on close', async () => {
        const { closed, socketFor } = fakeSockets();
        const transport = liveOverSockets({ calls, socketFor });
        expect(await transport.call('Chat#get', ['ws:c1'])).toBe('called Chat#get');
        transport.live!().subscribe(sub('Chat', 'ws:c1'), () => {});
        await transport.close?.();
        expect(closed).toEqual(['Chat/ws:c1']);
    });

    it('encodes both path segments', () => {
        expect(actorSocketPath('task', 'ws/1:t 2')).toBe('/_sigx/socket/task/ws%2F1%3At%202');
    });

    describe('reportingConnect (the connection pill, OPS-04)', () => {
        /** A connection whose events the test fires by hand. */
        function fakeLink() {
            let handlers!: SocketHandlers;
            const sent: string[] = [];
            let closes = 0;
            const connect = (h: SocketHandlers) => ((handlers = h), { send: (m: string) => void sent.push(m), close: () => void closes++ });
            return { connect, sent, fire: () => handlers, closes: () => closes };
        }

        it('says open on open and dropped on a close nobody asked for, passing every event through', () => {
            const said: string[] = [];
            const events: string[] = [];
            const link = fakeLink();
            const conn = reportingConnect(link.connect, { onOpen: () => said.push('open'), onDrop: () => said.push('drop') })({
                onOpen: () => events.push('open'),
                onMessage: (m) => events.push(`msg ${m}`),
                onClose: () => events.push('close')
            });
            link.fire().onOpen();
            link.fire().onMessage('x');
            conn.send('y');
            link.fire().onClose();
            expect(said).toEqual(['open', 'drop']);
            expect(events).toEqual(['open', 'msg x', 'close']);
            expect(link.sent).toEqual(['y']);
        });

        it('a close the transport made itself is not a drop', () => {
            const said: string[] = [];
            const link = fakeLink();
            const conn = reportingConnect(link.connect, { onOpen: () => said.push('open'), onDrop: () => said.push('drop') })({ onOpen: () => {}, onMessage: () => {}, onClose: () => {} });
            link.fire().onOpen();
            conn.close();
            link.fire().onClose();
            expect(link.closes()).toBe(1);
            expect(said).toEqual(['open']);
        });

        it('a dial that never opened is a drop: the transport is retrying', () => {
            const said: string[] = [];
            const link = fakeLink();
            reportingConnect(link.connect, { onDrop: () => said.push('drop') })({ onOpen: () => {}, onMessage: () => {}, onClose: () => {} });
            link.fire().onClose();
            expect(said).toEqual(['drop']);
        });

        describe('with a grace (#1024)', () => {
            /** Timers the test runs by hand. */
            function fakeTimers() {
                const pending = new Map<number, () => void>();
                let next = 0;
                return {
                    setTimer: (run: () => void) => (pending.set(++next, run), next),
                    clearTimer: (h: unknown) => void pending.delete(h as number),
                    pending: () => pending.size,
                    fire() {
                        const runs = Array.from(pending.values());
                        pending.clear();
                        for (const run of runs) run();
                    }
                };
            }
            const handlers = { onOpen: () => {}, onMessage: () => {}, onClose: () => {} };

            it('a drop the socket recovers from within the grace is never reported: a handover after a wake', () => {
                const said: string[] = [];
                const timers = fakeTimers();
                const first = fakeLink();
                const second = fakeLink();
                const links = [first, second];
                const conn = reportingConnect((h) => links.shift()!.connect(h), { onOpen: () => said.push('open'), onDrop: () => said.push('drop') }, { graceMs: 5_000, ...timers });
                conn(handlers);
                first.fire().onOpen();
                first.fire().onClose();
                expect(timers.pending()).toBe(1);
                conn(handlers);
                second.fire().onOpen();
                expect(timers.pending()).toBe(0);
                timers.fire();
                expect(said).toEqual(['open', 'open']);
            });

            it('a drop still down when the grace ends is reported', () => {
                const said: string[] = [];
                const timers = fakeTimers();
                const first = fakeLink();
                const retry = fakeLink();
                const links = [first, retry];
                const conn = reportingConnect((h) => links.shift()!.connect(h), { onOpen: () => said.push('open'), onDrop: () => said.push('drop') }, { graceMs: 5_000, ...timers });
                conn(handlers);
                first.fire().onOpen();
                first.fire().onClose();
                conn(handlers);
                retry.fire().onClose();
                expect(timers.pending()).toBe(1);
                timers.fire();
                expect(said).toEqual(['open', 'drop']);
            });

            it('a close the transport made itself cancels a pending drop', () => {
                const said: string[] = [];
                const timers = fakeTimers();
                const first = fakeLink();
                const second = fakeLink();
                const links = [first, second];
                const conn = reportingConnect((h) => links.shift()!.connect(h), { onDrop: () => said.push('drop') }, { graceMs: 5_000, ...timers });
                conn(handlers);
                first.fire().onOpen();
                first.fire().onClose();
                conn(handlers).close();
                expect(timers.pending()).toBe(0);
                expect(said).toEqual([]);
            });
        });
    });
});
