/** `memoryConformance` against the Memory actor on Durable Object storage, over the Worker's HTTP mount (#26 deferred this run here). */
import type { MemoryScope, WorkspaceId } from '@agentic/core';
import { memoryConformance } from '@agentic/memory/testing';
import { Memory, actorMemoryStore, memoryActorKey, type MemoryActorClient } from '@agentic/platform';
import { overHttp, signIn } from './http';

const userId = 'gh_memory';
const WS = userId as WorkspaceId;
let cookie = '';

beforeAll(async () => {
    cookie = await signIn(userId);
});

describe('memoryConformance: Memory actor on Durable Object storage', () => {
    // A small wire batch so the export/import cases cross page boundaries.
    const make = (scope: MemoryScope) => actorMemoryStore(overHttp(Memory, memoryActorKey(WS, scope), cookie) as unknown as MemoryActorClient, 2);
    for (const c of memoryConformance(make)) it(c.name, c.run);
});
