/**
 * The ReleaseDirectory (#365): the channel manifests fetched, validated and cached; a failed read keeps the last good
 * copy and says why; `get` never fetches in the caller's turn but arms the refresh; only a user refreshes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Principal, ReleaseManifest } from '@agentic/core';
import { manualScheduler, type ManualScheduler } from '@sigx/actors/host';

import { defineReleaseDirectory, parseReleaseManifest, RELEASE_CHECK_MIN_MS, RELEASE_DIRECTORY_KEY, RELEASE_MANIFEST_MAX_BYTES, RELEASE_SOURCES } from '../../src/releases/index';
import { statusOf, testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const SHA = 'a'.repeat(64);
const manifest = (version: string, channel: 'stable' | 'latest' = 'stable'): ReleaseManifest => ({
    version,
    channel,
    publishedAt: 1_700_000_000_000,
    commit: 'abc1234',
    protocol: 1,
    notesUrl: `https://github.com/andtii/agentic/releases/tag/daemon-v${version}`,
    assets: { 'win32-x64': { url: `https://github.com/andtii/agentic/releases/download/daemon-v${version}/agentic-daemon-win32-x64.zip`, sha256: SHA, bytes: 1234, version } },
    harnesses: {}
});

type Answer = Response | Error | (() => Promise<Response>);
let answers: Record<string, Answer>;
let fetched: string[];
const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    fetched.push(url);
    const a = answers[url];
    if (!a) return new Response('not found', { status: 404 });
    if (a instanceof Error) throw a;
    if (typeof a === 'function') {
        // A server that never answers: only the abort ends it.
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    }
    return a.clone();
}) as typeof fetch;
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

const TICK = 60_000;
let app: TestActorApp;
let scheduler: ManualScheduler;
const Releases = defineReleaseDirectory({ fetch: fakeFetch, timeoutMs: 50 });
const owner = userPrincipal('u1');
const asMachine: Principal = { kind: 'machine', workspaceId: 'u1' as Principal['workspaceId'], machineId: 'machine_1' as never };
const directory = (principal: Principal | null = owner) => app.as(principal).actor(Releases, RELEASE_DIRECTORY_KEY);

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    answers = { [RELEASE_SOURCES.stable]: json(manifest('0.2.0')), [RELEASE_SOURCES.latest]: json(manifest('0.3.0-main.abc1234', 'latest')) };
    fetched = [];
    scheduler = manualScheduler();
    app = testActorApp([Releases], { scheduler, defaults: { reminderTickMs: TICK, sweepIntervalMs: 0, callTimeoutMs: 0 } });
    await app.start();
});

afterEach(async () => {
    await app.stop();
    vi.useRealTimers();
});

const advance = async (ms: number) => {
    vi.setSystemTime(Date.now() + ms);
    scheduler.advance(ms);
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('ReleaseDirectory (#365)', () => {
    it('refresh reads both channels and keeps them; get answers from the cache', async () => {
        const view = await directory().refresh();
        expect(view.channels.stable?.version).toBe('0.2.0');
        expect(view.channels.latest?.version).toBe('0.3.0-main.abc1234');
        expect(view.channels.stable?.assets['win32-x64']?.sha256).toBe(SHA);
        expect(view.error).toBeUndefined();
        expect(view.lastCheckedAt).toBeGreaterThan(0);
        expect(fetched.sort()).toEqual([RELEASE_SOURCES.latest, RELEASE_SOURCES.stable].sort());
        fetched = [];
        expect(await directory(asMachine).get()).toEqual(view);
        expect(fetched).toEqual([]);
    });

    it('a failed read keeps the last good manifest and records why, per channel', async () => {
        await directory().refresh();
        answers[RELEASE_SOURCES.stable] = new Response('boom', { status: 500 });
        answers[RELEASE_SOURCES.latest] = json({ ...manifest('0.4.0', 'latest'), assets: { 'win32-x64': { url: 'x', sha256: 'nope', bytes: -1, version: '0.4.0' } } });
        const view = await directory().refresh();
        expect(view.channels.stable?.version).toBe('0.2.0');
        expect(view.channels.latest?.version).toBe('0.3.0-main.abc1234');
        expect(view.error).toMatch(/stable: HTTP 500/);
        expect(view.error).toMatch(/latest: assets\.win32-x64/);
        // The next good read clears the error.
        answers[RELEASE_SOURCES.stable] = json(manifest('0.2.1'));
        answers[RELEASE_SOURCES.latest] = json(manifest('0.4.0', 'latest'));
        const healed = await directory().refresh();
        expect(healed.error).toBeUndefined();
        expect(healed.channels.stable?.version).toBe('0.2.1');
    });

    it('refuses a manifest that is not JSON, too large, or never answers', async () => {
        answers[RELEASE_SOURCES.stable] = new Response('{not json');
        answers[RELEASE_SOURCES.latest] = new Response('x'.repeat(RELEASE_MANIFEST_MAX_BYTES + 1));
        let view = await directory().refresh();
        expect(view.channels).toEqual({});
        expect(view.error).toMatch(/stable: the manifest is not JSON/);
        expect(view.error).toMatch(/latest: the manifest is more than 1048576 bytes/);
        answers[RELEASE_SOURCES.stable] = () => Promise.reject(new Error('unused'));
        answers[RELEASE_SOURCES.latest] = new Error('network down');
        view = await directory().refresh();
        expect(view.error).toMatch(/stable: no answer within 50 ms/);
        expect(view.error).toMatch(/latest: network down/);
    });

    it('get never fetches in the caller turn: it arms the refresh, which reads and re-arms hourly', async () => {
        const first = await directory(asMachine).get();
        expect(first.channels).toEqual({});
        expect(fetched).toEqual([]);
        await advance(TICK);
        expect(fetched).toHaveLength(2);
        expect((await directory(asMachine).get()).channels.stable?.version).toBe('0.2.0');
        fetched = [];
        answers[RELEASE_SOURCES.stable] = json(manifest('0.2.1'));
        await advance(60 * 60_000);
        expect(fetched).toHaveLength(2);
        expect((await directory(asMachine).get()).channels.stable?.version).toBe('0.2.1');
    });

    it('check reads now, but at most once per RELEASE_CHECK_MIN_MS — a burst of page visits reads GitHub once (#468)', async () => {
        const first = await directory(asMachine).check();
        expect(fetched).toHaveLength(2);
        expect(first.channels.stable?.version).toBe('0.2.0');
        answers[RELEASE_SOURCES.stable] = json(manifest('0.2.1'));
        await directory(asMachine).check();
        await directory().check(0);
        expect(fetched).toHaveLength(2);
        await advance(RELEASE_CHECK_MIN_MS);
        expect((await directory(asMachine).check()).channels.stable?.version).toBe('0.2.1');
        expect(fetched).toHaveLength(4);
    });

    it('get is for anyone signed in; refresh only for a user', async () => {
        expect(await statusOf(directory(null).get())).toBe(401);
        expect(await statusOf(directory(asMachine).refresh())).toBe(403);
        expect(await statusOf(directory(asMachine).get())).toBeUndefined();
    });

    it('a source given as undefined keeps the default URL', async () => {
        const Other = defineReleaseDirectory({ fetch: fakeFetch, sources: { stable: undefined, latest: 'https://example.test/latest.json' } });
        const other = testActorApp([Other]);
        await other.start();
        try {
            answers['https://example.test/latest.json'] = json(manifest('0.5.0', 'latest'));
            const view = await other.as(owner).actor(Other, RELEASE_DIRECTORY_KEY).refresh();
            expect(view.channels.stable?.version).toBe('0.2.0');
            expect(view.channels.latest?.version).toBe('0.5.0');
            expect(fetched).toContain(RELEASE_SOURCES.stable);
        } finally {
            await other.stop();
        }
    });

    it('parseReleaseManifest rebuilds a valid manifest and names the bad field', () => {
        const m = manifest('1.0.0');
        expect(parseReleaseManifest({ ...m, extra: true })).toEqual(m);
        expect(parseReleaseManifest({ ...m, harnesses: undefined })).toEqual(m);
        expect(() => parseReleaseManifest({ ...m, version: 'one' })).toThrow(/version/);
        expect(() => parseReleaseManifest({ ...m, channel: 'beta' })).toThrow(/channel/);
        expect(() => parseReleaseManifest({ ...m, assets: { 'linux-x64': { ...m.assets['win32-x64'], url: 'http://insecure' } } })).toThrow(/assets\.linux-x64/);
        expect(() => parseReleaseManifest({ ...m, harnesses: { 'claude-code': { version: '' } } })).toThrow(/harnesses\.claude-code/);
        expect(() => parseReleaseManifest([])).toThrow(/not an object/);
    });
});
