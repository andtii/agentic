/** JSON-over-WebSocket framing: size limit first, then version, then kind, then the schema; every refusal has a named code. */

import { DAEMON_PROTOCOL_VERSION } from '@agentic/core';
import type { PlatformFrame } from '../src/index';
import { DaemonProtocolError, FRAME_ERROR_CODES, LIMITS, decodeDaemonFrame, decodePlatformFrame, encodeFrame, frameBytes, parseDaemonFrame, parsePlatformFrame } from '../src/index';

const V = DAEMON_PROTOCOL_VERSION;
const ping: PlatformFrame = { v: V, t: 'ping' };

const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? 'ok' : r.error!.code);

describe('framing', () => {
    it('round-trips a frame as one text message', () => {
        const text = encodeFrame(ping);
        expect(text).toBe('{"v":1,"t":"ping"}');
        expect(decodePlatformFrame(text)).toEqual({ ok: true, frame: ping });
        expect(decodeDaemonFrame(encodeFrame({ v: V, t: 'pong', at: 7 }))).toEqual({ ok: true, frame: { v: V, t: 'pong', at: 7 } });
    });

    it('accepts binary messages as UTF-8', () => {
        const bytes = new TextEncoder().encode(encodeFrame(ping));
        expect(decodePlatformFrame(bytes)).toEqual({ ok: true, frame: ping });
        expect(decodePlatformFrame(bytes.buffer as ArrayBuffer)).toEqual({ ok: true, frame: ping });
        expect(frameBytes('é')).toBe(2);
        expect(frameBytes(bytes)).toBe(bytes.byteLength);
    });

    it('rejects an unknown protocol version with a named code', () => {
        const r = decodePlatformFrame(JSON.stringify({ v: V + 1, t: 'ping' }));
        expect(code(r)).toBe('unsupported-version');
        if (!r.ok) expect(r.error.message).toMatch(/v2 is not supported; this end speaks v1/);
        expect(code(decodeDaemonFrame(JSON.stringify({ t: 'pong', at: 1 })))).toBe('unsupported-version');
        expect(code(parseDaemonFrame({ v: '1', t: 'pong', at: 1 }))).toBe('unsupported-version');
    });

    it('names every other refusal', () => {
        expect(code(decodePlatformFrame('{nope'))).toBe('not-json');
        expect(code(decodePlatformFrame('[]'))).toBe('not-object');
        expect(code(decodePlatformFrame('"ping"'))).toBe('not-object');
        expect(code(parsePlatformFrame(null))).toBe('not-object');
        expect(code(decodePlatformFrame(JSON.stringify({ v: V, t: 'hello' })))).toBe('unknown-type');
        expect(code(decodeDaemonFrame(JSON.stringify({ v: V, t: 'ping' })))).toBe('unknown-type');
        const invalid = decodePlatformFrame(JSON.stringify({ v: V, t: 'session.close', sessionId: 5 }));
        expect(code(invalid)).toBe('invalid');
        if (!invalid.ok) {
            expect(invalid.error.issues).toEqual([{ path: 'sessionId', message: expect.any(String) }]);
            expect(invalid.error.message).toMatch(/^invalid platform frame session\.close: sessionId: /);
        }
        expect(FRAME_ERROR_CODES).toEqual(['too-large', 'not-json', 'not-object', 'unsupported-version', 'unknown-type', 'invalid']);
    });

    it('decodes an older daemon\'s hello without any lifecycle field, and names a platform frame it does not know (#360)', () => {
        // A daemon that predates #359 sends no build, features, restarts, lastExit, lastUpdate or harnesses.
        const hello = { v: V, t: 'hello', machineId: 'm1', daemonVersion: '0.1.0', os: 'linux', environments: [], capabilities: [], resume: {} };
        expect(decodeDaemonFrame(JSON.stringify(hello))).toEqual({ ok: true, frame: hello });
        // A frame family a daemon does not answer yet is unknown-type — it drops it and keeps the socket, which `hello.features` relies on.
        const later = decodePlatformFrame(JSON.stringify({ v: V, t: 'update.schedule', requestId: 'u_1' }));
        expect(code(later)).toBe('unknown-type');
        if (!later.ok) expect(later.error.message).toBe('unknown platform frame type "update.schedule"');
    });

    it('refuses an oversized message before parsing it', () => {
        const big = `{"v":${V},"t":"ping","pad":"${'x'.repeat(LIMITS.frameBytes)}"}`;
        expect(code(decodePlatformFrame(big))).toBe('too-large');
        expect(code(decodePlatformFrame(big, { maxBytes: LIMITS.frameBytes + 100 }))).toBe('ok');
        expect(code(decodePlatformFrame('{"v":1,"t":"ping"}', { maxBytes: 4 }))).toBe('too-large');
    });

    it('will not encode what the peer would drop', () => {
        const frame: PlatformFrame = { v: V, t: 'tool.result', callId: 'k', output: 'x'.repeat(LIMITS.frameBytes) };
        expect(() => encodeFrame(frame)).toThrow(DaemonProtocolError);
        try {
            encodeFrame(frame);
        } catch (e) {
            expect((e as DaemonProtocolError).code).toBe('too-large');
            expect((e as DaemonProtocolError).name).toBe('DaemonProtocolError');
        }
        expect(() => encodeFrame(ping, { maxBytes: 4 })).toThrow(/ping frame of 18 bytes exceeds the 4 byte limit/);
    });
});
