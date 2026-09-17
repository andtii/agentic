/** `memoryConformance` against the Memory actor over `memoryStorage()` (MEM-02 acceptance: both storages). */
import type { MemoryScope, Principal, WorkspaceId } from '@agentic/core';
import { memoryConformance } from '@agentic/memory/testing';
import { actor } from '@sigx/actors';
import { createHost, memoryStorage, type Host } from '@sigx/actors/host';
import { stubServerApp } from '@sigx/server/testing';
import { actorMemoryStore, Memory, memoryActorKey } from '../src/index';

const quiet = { sweepIntervalMs: 60_000, reminderTickMs: 60_000, callTimeoutMs: 0 };
const WS = 'ws_conf' as WorkspaceId;
const user: Principal = { kind: 'user', userId: 'owner', workspaceId: WS };

describe('memoryConformance: Memory actor over memoryStorage()', () => {
    let host: Host;
    let restore: () => void;

    beforeAll(async () => {
        restore = stubServerApp({ authenticate: () => user, codec: { encode: (p) => JSON.stringify(p), decode: (s) => (s ? (JSON.parse(s) as Principal) : null) } });
        host = createHost({ actors: [Memory], storage: memoryStorage(), defaults: quiet });
        await host.start();
    });

    afterAll(async () => {
        await host.stop();
        restore();
    });

    // A small wire batch so the export/import cases cross page boundaries.
    const make = (scope: MemoryScope) => actorMemoryStore(actor(Memory, memoryActorKey(WS, scope)), 2);
    for (const c of memoryConformance(make)) it(c.name, c.run);
});
