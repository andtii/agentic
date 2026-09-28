import { LIVE_SOCKET_TAG, SESSION_EVICTED_CODE, closeOrphanedLiveSockets } from '../src/actors/hibernation';

function fakeSocket(throws = false) {
    const closes: [number | undefined, string | undefined][] = [];
    return {
        closes,
        send: () => {},
        close(code?: number, reason?: string) {
            if (throws) throw new Error('already closed');
            closes.push([code, reason]);
        },
        serializeAttachment: () => {},
        deserializeAttachment: () => ({ v: 1 })
    };
}

describe('closeOrphanedLiveSockets (#714)', () => {
    it('closes every live socket an earlier instance accepted with 1012, and returns them', () => {
        const a = fakeSocket();
        const b = fakeSocket(true);
        const asked: (string | undefined)[] = [];
        const orphans = closeOrphanedLiveSockets({ getWebSockets: (tag) => (asked.push(tag), [a, b]) });
        expect(asked).toEqual([LIVE_SOCKET_TAG]);
        expect(a.closes).toEqual([[SESSION_EVICTED_CODE, 'session evicted — reconnect']]);
        expect([...orphans]).toEqual([a, b]);
    });

    it('is a no-op on a runtime without the hibernation API', () => {
        expect(closeOrphanedLiveSockets({}).size).toBe(0);
    });
});
