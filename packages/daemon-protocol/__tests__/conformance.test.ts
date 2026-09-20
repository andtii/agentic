/** The conformance suite passes against the in-memory pair — and fails against a daemon broken on purpose. */

import type { ConformanceCase } from '../src/testing/index';
import { ConformanceError, daemonConformance, inMemoryEnvironment, inMemoryHarness, type InMemoryFaults } from '../src/testing/index';

/** Two checkouts of one origin (spelled two ways) in the fake tree, plus one of another repo, so `fs-locate` proves a match (#331). */
const REPOS = [
    { path: '/work/agentic', git: { kind: 'repo', branch: 'main', origin: 'https://github.com/andtii/agentic.git' } },
    { path: '/work/branches/agentic-x', git: { kind: 'worktree', branch: 'x', origin: 'git@github.com:andtii/agentic' } },
    { path: '/work/other', git: { kind: 'repo', branch: 'main', origin: 'https://github.com/andtii/other.git' } }
] as const;

describe('daemonConformance × inMemoryHarness', () => {
    const cases = daemonConformance(inMemoryHarness({ repos: REPOS }), { timeoutMs: 2_000 });

    it('has every scenario the issue names, none skipped', () => {
        expect(cases.map((c) => c.name)).toEqual(['hello-welcome', 'malformed-input', 'env', 'heartbeat', 'session', 'session-ref', 'reconnect-replay', 'gap', 'fs-list', 'fs-locate', 'env-put', 'env-remove', 'env-policy', 'tool-round-trip']);
        expect(cases.filter((c) => c.skip)).toEqual([]);
    });

    for (const c of cases) it.skipIf(!!c.skip)(c.name, c.run);

    it('skips the cases a harness cannot support, with a reason', () => {
        const bare = daemonConformance({ start: () => inMemoryHarness().start({ events: 3, heartbeatMs: 10 }) });
        expect(bare.filter((c) => c.skip).map((c) => [c.name, c.skip])).toEqual([
            ['env', 'the harness does not declare the "env" feature'],
            ['session-ref', 'the harness does not declare the "session-ref" feature'],
            ['gap', 'the harness does not declare the "gap" feature'],
            ['fs-list', 'the harness does not declare the "fs" feature'],
            ['fs-locate', 'the harness does not declare the "fs" feature'],
            ['env-put', 'the harness does not declare the "env-manage" feature'],
            ['env-remove', 'the harness does not declare the "env-manage" feature'],
            ['env-policy', 'the harness does not declare the "env-manage" feature']
        ]);
    });
});

describe('daemonConformance catches a broken daemon', () => {
    // The fake emits one frame per macrotask, so 300 ms away is enough for the whole turn to land in its log.
    const only = (name: string, faults: InMemoryFaults): ConformanceCase =>
        daemonConformance(inMemoryHarness({ faults }), { timeoutMs: 500, events: 30, reconnectDelayMs: 300 }).find((c) => c.name === name)!;

    it('a replay that repeats what the platform had (OPS-06)', async () => {
        await expect(only('reconnect-replay', { replay: 'duplicate' }).run()).rejects.toThrow(/a duplicate or an out-of-order frame/);
    });

    it('a replay that skips a frame', async () => {
        await expect(only('reconnect-replay', { replay: 'skip' }).run()).rejects.toThrow(/a gap/);
    });

    it('a replay that ignores wanted', async () => {
        await expect(only('reconnect-replay', { replay: 'ignore' }).run()).rejects.toThrow(ConformanceError);
    });

    it('a daemon that answers frames from another protocol version', async () => {
        await expect(only('malformed-input', { answerAnyVersion: true }).run()).rejects.toThrow(/expected a session\.opened frame, got pong/);
    });

    it('a daemon that lists folders outside its working roots (OPS-01)', async () => {
        await expect(only('fs-list', { browseAnywhere: true }).run()).rejects.toThrow(/a folder outside the working roots is refused/);
    });

    it('a daemon that locates checkouts outside its working roots (OPS-01)', async () => {
        const stray = daemonConformance(inMemoryHarness({ repos: [{ path: '/elsewhere/agentic', git: { kind: 'repo', origin: REPOS[0].git.origin } }], faults: { locateAnywhere: true } }), { timeoutMs: 500 }).find((c) => c.name === 'fs-locate')!;
        await expect(stray.run()).rejects.toThrow(/located checkout \/elsewhere\/agentic is inside the working roots/);
    });

    it('a daemon that finds nothing of an origin it holds', async () => {
        const blind = daemonConformance(inMemoryHarness({ repos: [{ path: '/work/agentic', git: { kind: 'repo', origin: REPOS[0].git.origin } }], environments: [{ ...inMemoryEnvironment(), cwdRoots: ['/other'] }] }), { timeoutMs: 500 }).find((c) => c.name === 'fs-locate')!;
        await expect(blind.run()).rejects.toThrow(/is found under the working roots/);
    });

    it('a daemon that takes working roots outside the allowed roots (OPS-01)', async () => {
        await expect(only('env-put', { acceptAnyRoot: true }).run()).rejects.toThrow(/a working root outside the allowed roots is refused/);
    });

    it('a daemon that removes an environment with running sessions', async () => {
        await expect(only('env-remove', { removeInUse: true }).run()).rejects.toThrow(/an environment with a running session is not removed/);
    });

    it('a daemon that manages environments with the policy off', async () => {
        await expect(only('env-policy', { ignorePolicy: true }).run()).rejects.toThrow(/with the policy off nothing is created/);
    });

    it('a daemon whose policy does not allow the web at all cannot claim the feature', async () => {
        const off = daemonConformance(inMemoryHarness({ policy: { webManaged: false, allowedRoots: [] } }), { timeoutMs: 500 }).find((c) => c.name === 'env-put')!;
        await expect(off.run()).rejects.toThrow(/hello\.policy says the web may manage environments/);
    });

    it('a daemon that reports the placeholder id as its own (#388)', async () => {
        await expect(only('session-ref', { sameRef: true }).run()).rejects.toThrow(/not the placeholder session\.opened carried/);
    });

    it('a daemon that never announces environments', async () => {
        await expect(only('env', { silentEnv: true }).run()).rejects.toThrow(/timed out after 500 ms waiting for env/);
    });
});
