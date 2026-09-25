/** `fs.request` `pin` / `read-at` on the wire (#752): bounded ranges, and results that are exactly the lines asked. */
import { DAEMON_PROTOCOL_VERSION, FS_PIN_MAX_LINES } from '@agentic/core';
import { daemonFrameSchemas, platformFrameSchemas } from '../src/index';

const V = DAEMON_PROTOCOL_VERSION;
const SHA = '4f2a9c1'.padEnd(40, '0');
const request = (op: Record<string, unknown>) => platformFrameSchemas['fs.request'].safeParse({ v: V, t: 'fs.request', requestId: 'fs_1', environmentId: 'env_a', op });
const response = (f: Record<string, unknown>) => daemonFrameSchemas['fs.response'].safeParse({ v: V, t: 'fs.response', requestId: 'fs_1', ...f });

describe('fs pin / read-at frames (#752)', () => {
    it('a request names a root, a relative path and a 1-based range; read-at adds the sha', () => {
        const pin = { kind: 'pin', root: '/work/app', path: 'src/app.ts', from: 38, to: 41 };
        expect(request(pin)).toMatchObject({ success: true, data: { op: pin } });
        expect(request({ ...pin, kind: 'read-at', sha: SHA }).success).toBe(true);
        expect(request({ ...pin, kind: 'read-at' }).success).toBe(false);
        expect(request({ ...pin, from: 0 }).success).toBe(false);
        expect(request({ ...pin, to: 1.5 }).success).toBe(false);
        expect(request({ ...pin, path: '' }).success).toBe(false);
    });

    it('a result carries the sha and exactly the lines from–to, bounded', () => {
        const lines = ['a', 'b', 'c', 'd'];
        expect(response({ result: { kind: 'pin', path: 'src/app.ts', sha: SHA, from: 38, to: 41, lines } }).success).toBe(true);
        expect(response({ result: { kind: 'read-at', path: 'src/app.ts', sha: SHA, from: 38, to: 41, lines } }).success).toBe(true);
        expect(response({ result: { kind: 'pin', path: 'src/app.ts', sha: SHA, from: 38, to: 41, lines: ['a'] } }).success).toBe(false);
        expect(response({ result: { kind: 'pin', path: 'src/app.ts', from: 38, to: 41, lines } }).success).toBe(false);
        const many = Array.from({ length: FS_PIN_MAX_LINES + 1 }, () => 'x');
        expect(response({ result: { kind: 'pin', path: 'a', sha: SHA, from: 1, to: many.length, lines: many } }).success).toBe(false);
    });
});
