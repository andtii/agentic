/** The conformance suite passes against the in-memory pair — and fails against a daemon broken on purpose. */

import type { ConformanceCase } from '../src/testing/index';
import { ConformanceError, daemonConformance, inMemoryHarness, type InMemoryFaults } from '../src/testing/index';

describe('daemonConformance × inMemoryHarness', () => {
    const cases = daemonConformance(inMemoryHarness(), { timeoutMs: 2_000 });

    it('has every scenario the issue names, none skipped', () => {
        expect(cases.map((c) => c.name)).toEqual(['hello-welcome', 'malformed-input', 'env', 'heartbeat', 'session', 'reconnect-replay', 'gap', 'fs-list', 'tool-round-trip']);
        expect(cases.filter((c) => c.skip)).toEqual([]);
    });

    for (const c of cases) it.skipIf(!!c.skip)(c.name, c.run);

    it('skips the cases a harness cannot support, with a reason', () => {
        const bare = daemonConformance({ start: () => inMemoryHarness().start({ events: 3, heartbeatMs: 10 }) });
        expect(bare.filter((c) => c.skip).map((c) => [c.name, c.skip])).toEqual([
            ['env', 'the harness does not declare the "env" feature'],
            ['gap', 'the harness does not declare the "gap" feature'],
            ['fs-list', 'the harness does not declare the "fs" feature']
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

    it('a daemon that never announces environments', async () => {
        await expect(only('env', { silentEnv: true }).run()).rejects.toThrow(/timed out after 500 ms waiting for env/);
    });
});
