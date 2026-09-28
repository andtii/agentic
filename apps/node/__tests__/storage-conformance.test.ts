/**
 * The shared `ActorStorage` conformance suite, run against the Node host's
 * `sqliteStorage` — on a temp FILE (WAL sidecars and all, what the host runs
 * on) and on `:memory:`.
 *
 * Gated on `node:sqlite` being importable: it needs Node >= 22.13 and CI's
 * compat leg runs Node 20. `@sigx/actors-sqlite` imports `node:sqlite`
 * statically, so it is loaded dynamically AFTER the probe.
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storageConformance, type StorageConformanceFactory } from './conformance/storage';

const hasSqlite = await import('node:sqlite').then(
    () => true,
    () => false
);
const mod = hasSqlite ? await import('../src/index') : null;

const onFile: StorageConformanceFactory = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentic-node-conformance-'));
    const storage = mod!.sqliteStorage({ path: join(dir, 'actors.db') });
    return {
        storage: () => storage,
        saveText: true,
        appendText: true,
        async stop() {
            storage.close();
            await rm(dir, { recursive: true, force: true });
        }
    };
};

const inMemory: StorageConformanceFactory = async () => {
    const storage = mod!.sqliteStorage({ path: ':memory:' });
    return {
        storage: () => storage,
        saveText: true,
        appendText: true,
        async stop() {
            storage.close();
        }
    };
};

for (const [label, factory] of [
    ['temp file', onFile],
    [':memory:', inMemory]
] as const) {
    describe.skipIf(!hasSqlite)(`storage conformance: sqliteStorage (${label})`, () => {
        for (const testCase of storageConformance) {
            it(testCase.name, async () => {
                // Every case must RUN: the adapter declares saveText and appendText.
                expect(await testCase.run(factory)).toBeUndefined();
            });
        }
    });
}
