// @vitest-environment node
import type { AgentEvent } from '@sigx/ai-agent';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backoffDelay } from '../src/connection';
import { ndjsonEventLog } from '../src/event-log';
import { daemonSocketUrl, normalizePairingCode, normalizePlatformUrl, pair, PairingError } from '../src/pair';

const ev = (seq: number, sessionId = 'runtime_1', epoch = 1): AgentEvent => ({ type: 'part-delta', partId: 'p', delta: `${seq}`, turnId: 't', sessionId, epoch, seq }) as AgentEvent;

const collect = async <T>(it: AsyncIterable<T>): Promise<T[]> => {
    const out: T[] = [];
    for await (const x of it) out.push(x);
    return out;
};

describe('NDJSON session log', () => {
    let dir: string;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'agentic-log-'));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('appends in order, reads after a cursor, reports its head', async () => {
        const log = ndjsonEventLog(dir);
        for (let i = 1; i <= 50; i++) void log.append(ev(i));
        expect((await collect(log.read('runtime_1', { epoch: 1, seq: 45 }))).map((e) => e.seq)).toEqual([46, 47, 48, 49, 50]);
        expect(await log.head('runtime_1')).toEqual({ epoch: 1, seq: 50 });
        expect(await log.sessions()).toEqual(['runtime_1']);
        expect(await log.head('nothing_here')).toBeUndefined();
    });

    it('forSession files events under the platform session id, whatever the runtime calls the session', async () => {
        const log = ndjsonEventLog(dir);
        const store = log.forSession('session_platform');
        await store.append(ev(1, 'runtime_xyz'));
        await store.append(ev(2, 'runtime_xyz'));
        expect((await collect(store.read('runtime_xyz', { epoch: 1, seq: 0 }))).map((e) => e.seq)).toEqual([1, 2]);
        expect(await log.sessions()).toEqual(['session_platform']);
        const lines = (await readFile(join(dir, 'session_platform.ndjson'), 'utf8')).trim().split('\n');
        expect(JSON.parse(lines[0]!).sessionId).toBe('runtime_xyz');
    });

    it('skips a torn last line (a crash mid-write)', async () => {
        const log = ndjsonEventLog(dir);
        await log.append(ev(1));
        await log.flush();
        await appendFile(join(dir, 'runtime_1.ndjson'), '{"type":"part-delta","seq":');
        expect((await collect(log.read('runtime_1'))).map((e) => e.seq)).toEqual([1]);
    });

    it('truncate forgets older events', async () => {
        const log = ndjsonEventLog(dir);
        for (let i = 1; i <= 10; i++) void log.append(ev(i));
        await log.truncate('runtime_1', { epoch: 1, seq: 8 });
        expect((await collect(log.read('runtime_1'))).map((e) => e.seq)).toEqual([8, 9, 10]);
    });

    it('refuses a session id that is not a safe file name', async () => {
        const log = ndjsonEventLog(dir);
        expect(() => log.forSession('../escape')).toThrow(/safe file name/);
        await expect(log.append(ev(1, '..\\escape'))).rejects.toThrow(/safe file name/);
    });

    it('reports a failed write without failing the stream', async () => {
        const errors: unknown[] = [];
        const log = ndjsonEventLog(join(dir, 'file-not-dir'), { onError: (e) => errors.push(e) });
        await appendFile(join(dir, 'file-not-dir'), 'x');
        await log.append(ev(1));
        await log.flush();
        expect(errors).toHaveLength(1);
    });
});

describe('pair', () => {
    const TOKEN = `amt.ws_1.machine_1.${'a'.repeat(43)}`;
    const fetchReturning = (status: number, body: unknown, seen: { url?: string; body?: unknown } = {}) =>
        (async (url: string, init: RequestInit) => {
            seen.url = url;
            seen.body = JSON.parse(init.body as string);
            return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
        }) as unknown as typeof fetch;

    it('posts the normalised code and the machine name to /auth/pair', async () => {
        const seen: { url?: string; body?: unknown } = {};
        const result = await pair({ url: 'https://agentic.example/', code: 'abc-234', name: 'box', fetch: fetchReturning(200, { token: TOKEN, workspaceId: 'ws_1', machineId: 'machine_1' }, seen) });
        expect(seen).toEqual({ url: 'https://agentic.example/auth/pair', body: { code: 'ABC234', name: 'box' } });
        expect(result).toEqual({ url: 'https://agentic.example', token: TOKEN, workspaceId: 'ws_1', machineId: 'machine_1' });
    });

    it('maps the platform refusal to a readable reason', async () => {
        const failure = pair({ url: 'https://agentic.example', code: 'AAAAAA', name: 'box', fetch: fetchReturning(401, { error: 'expired' }) });
        await expect(failure).rejects.toBeInstanceOf(PairingError);
        await expect(failure).rejects.toMatchObject({ code: 'expired', status: 401, message: expect.stringMatching(/expired/) });
    });

    it('refuses a token that does not name the machine it was issued for', async () => {
        await expect(pair({ url: 'https://agentic.example', code: 'AAAAAA', name: 'box', fetch: fetchReturning(200, { token: TOKEN, workspaceId: 'ws_1', machineId: 'machine_2' }) })).rejects.toMatchObject({ code: 'bad_response' });
    });

    it('a non-JSON answer (the HTML page, a proxy) names the status and content type, not "unexpected token" (#180)', async () => {
        const html = (async () => new Response('<!doctype html><title>agentic</title>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })) as unknown as typeof fetch;
        await expect(pair({ url: 'http://localhost:8787', code: 'AAAAAA', name: 'box', fetch: html })).rejects.toMatchObject({
            code: 'not_json',
            status: 200,
            message: 'the platform did not answer as JSON (HTTP 200, text/html; charset=utf-8) — is the URL the agentic Worker and is pairing mounted?'
        });
        const empty = (async () => new Response(null, { status: 502 })) as unknown as typeof fetch;
        await expect(pair({ url: 'http://localhost:8787', code: 'AAAAAA', name: 'box', fetch: empty })).rejects.toMatchObject({ code: 'not_json', status: 502, message: expect.stringMatching(/HTTP 502, no content-type/) });
    });

    it('an unreachable platform is named', async () => {
        const down = (async () => {
            throw new TypeError('fetch failed');
        }) as unknown as typeof fetch;
        await expect(pair({ url: 'https://agentic.example', code: 'AAAAAA', name: 'box', fetch: down })).rejects.toMatchObject({ code: 'unreachable' });
    });

    it('urls and codes', () => {
        expect(() => normalizePlatformUrl('ftp://x')).toThrow(/http/);
        expect(daemonSocketUrl('https://agentic.example/', 'machine_1')).toBe('wss://agentic.example/_agentic/daemon/machine_1');
        expect(daemonSocketUrl('http://127.0.0.1:8787', 'machine_1')).toBe('ws://127.0.0.1:8787/_agentic/daemon/machine_1');
        expect(normalizePairingCode(' ab c-23 4 ')).toBe('ABC234');
    });
});

describe('backoff', () => {
    it('grows exponentially to the ceiling with bounded jitter', () => {
        const at = (attempt: number, r: number) => backoffDelay(attempt, { initialMs: 100, maxMs: 1_000, jitter: 0.2, random: () => r });
        expect([0, 1, 2, 3, 4, 10].map((a) => at(a, 0.5))).toEqual([100, 200, 400, 800, 1_000, 1_000]);
        expect(at(0, 0)).toBe(80);
        expect(at(0, 1)).toBe(120);
    });
});
