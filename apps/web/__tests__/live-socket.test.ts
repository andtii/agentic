import type { ActorSubscription, ActorTransport } from '@sigx/actors/client';
import { actorSocketPath, liveOverSockets } from '../src/actors/live-socket';

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
});
