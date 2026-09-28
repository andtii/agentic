import { createLiveChannel } from '@sigx/actors/app';
import { fetchTransport, type ActorLiveChannel, type ActorSubscription, type ActorTransport } from '@sigx/actors/client';
import { ACTOR_ENDPOINT } from '../src/actors/client';
import { pageTransport } from '../src/actors/page-transport';

/** A `fetch` that records every URL it is asked for and answers an empty NDJSON body. */
function recordingFetch() {
    const urls: string[] = [];
    const fetch = (async (input: RequestInfo | URL) => {
        urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        return new Response('', { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
    }) as typeof globalThis.fetch;
    return { urls, fetch };
}

function fakeSockets() {
    const opened: string[] = [];
    const socketFor = (type: string, key: string): ActorTransport => {
        opened.push(`${type}/${key}`);
        return {
            name: 'fake-socket',
            call: () => Promise.reject(new Error('no calls on the socket')),
            stream: () => {
                throw new Error('no streams on the socket');
            },
            live: () => ({ subscribe: (_sub, onValue) => (onValue(`${type}/${key}`), () => {}) }),
            close: () => {}
        };
    };
    return { opened, socketFor };
}

/** `createLiveChannel`, typed through the client's own channel contract. */
const channelOver = (transport: ActorTransport): ActorLiveChannel & { close(): void } => createLiveChannel(() => transport, { debounceMs: 1 }) as unknown as ActorLiveChannel & { close(): void };
const sub = (type: string, key: string, method = 'get'): ActorSubscription => ({ type, key, method });
const settle = () => new Promise((r) => setTimeout(r, 60));

describe('pageTransport (#715)', () => {
    it('live reads go on the actor sockets: no request to the NDJSON $live route', async () => {
        const { urls, fetch } = recordingFetch();
        const { opened, socketFor } = fakeSockets();
        const live = channelOver(pageTransport({ fetch, socketFor }));
        const values: unknown[] = [];
        const offs = [live.subscribe(sub('Chat', 'ws:c1'), (v) => values.push(v)), live.subscribe(sub('Workspace', 'ws'), (v) => values.push(v))];
        await settle();
        expect(opened).toEqual(['Chat/ws:c1', 'Workspace/ws']);
        expect(values).toEqual(['Chat/ws:c1', 'Workspace/ws']);
        expect(urls).toEqual([]);
        for (const off of offs) off();
        live.close();
    });

    it('calls stay POSTs on the actor mount', async () => {
        const { urls, fetch } = recordingFetch();
        const { socketFor } = fakeSockets();
        await pageTransport({ fetch, socketFor })
            .call('Chat#get', ['ws:c1'])
            .catch(() => {});
        expect(urls.length).toBe(1);
        expect(urls[0]).toContain(ACTOR_ENDPOINT);
        expect(urls[0]).not.toContain('$live');
    });

    it('control: the bare fetchTransport would open $live — what the page transport avoids', async () => {
        const { urls, fetch } = recordingFetch();
        const live = channelOver(fetchTransport({ endpoint: ACTOR_ENDPOINT, fetch }));
        const off = live.subscribe(sub('Chat', 'ws:c1'), () => {});
        await settle();
        off();
        live.close();
        expect(urls.some((u) => u.includes('$live'))).toBe(true);
    });
});
