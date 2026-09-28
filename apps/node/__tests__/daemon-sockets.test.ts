/** The Node host's daemon sockets (#988): the Machine actor's `MachineSocketPort` over a `Map`. */
import { describe, expect, it } from 'vitest';
import { DAEMON_PING_STALE_MS } from '../../web/src/daemon';
import { nodeDaemonSockets } from '../src/daemon-sockets';

const socket = () => {
    const sent: string[] = [];
    const closed: (string | undefined)[] = [];
    return { sent, closed, send: (text: string) => void sent.push(text), close: (_code?: number, reason?: string) => void closed.push(reason) };
};

describe('nodeDaemonSockets', () => {
    it('sends to the machine socket and says whether one was there', () => {
        const sockets = nodeDaemonSockets();
        const a = socket();
        expect(sockets.port.send('k', 'x')).toBe(false);
        sockets.add('k', a);
        expect(sockets.port.send('k', 'hello')).toBe(true);
        expect(a.sent).toEqual(['hello']);
    });

    it('a redial replaces the old socket, whose close does not take the machine offline', () => {
        const sockets = nodeDaemonSockets();
        const old = socket();
        const fresh = socket();
        sockets.add('k', old);
        sockets.add('k', fresh);
        expect(old.closed).toEqual(['replaced by a new daemon connection']);
        expect(sockets.port.send('k', 'frame')).toBe(true);
        expect(old.sent).toEqual([]);
        expect(fresh.sent).toEqual(['frame']);
        expect(sockets.remove('k', old)).toBe(false);
        expect(sockets.port.isConnected?.('k')).toBe(true);
        expect(sockets.remove('k', fresh)).toBe(true);
        expect(sockets.port.isConnected?.('k')).toBe(false);
    });

    it('stops counting a socket whose last keepalive is stale; one never pinged counts', () => {
        let now = 0;
        const sockets = nodeDaemonSockets(() => now);
        const a = socket();
        sockets.add('k', a);
        now = DAEMON_PING_STALE_MS * 10;
        expect(sockets.port.isConnected?.('k')).toBe(true);
        sockets.pinged('k', a);
        now += DAEMON_PING_STALE_MS - 1;
        expect(sockets.port.isConnected?.('k')).toBe(true);
        now += 2;
        expect(sockets.port.isConnected?.('k')).toBe(false);
    });

    it('closes every socket of the machine', () => {
        const sockets = nodeDaemonSockets();
        const a = socket();
        sockets.add('k', a);
        sockets.port.close('k', 4001, 'revoked');
        expect(a.closed).toEqual(['revoked']);
    });
});
