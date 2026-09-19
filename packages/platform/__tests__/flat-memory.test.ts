/**
 * The FlatMemory actor (#281): the flat memory plugin's durable backend. The `memoryConformance` core (the flat
 * plugin's four missing features left out), the scope authorization and the shared-scope ACL — the Memory actor's —
 * exactly as the default enforces them (MEM-04, MEM-11), persistence across a deactivation, and a store of its own:
 * the two plugins' records of one scope never mix.
 */
import type { AgentId, MemoryScope, Principal, SessionId, WorkspaceId } from '@agentic/core';
import { FLAT_MEMORY_PLUGIN_ID, FLAT_UNSUPPORTED_FIELDS } from '@agentic/memory';
import { memoryConformance, type MemoryFeature } from '@agentic/memory/testing';
import { actor } from '@sigx/actors';
import { createHost, memoryStorage, type Host } from '@sigx/actors/host';
import { isServerFnError } from '@sigx/server';
import { stubServerApp } from '@sigx/server/testing';
import { actorMemoryStore, FlatMemory, flatMemoryActorPlugin, Memory, memoryActorKey } from '../src/index';

const quiet = { sweepIntervalMs: 60_000, reminderTickMs: 60_000, callTimeoutMs: 0 };
const WS = 'ws_flat' as WorkspaceId;
const A = 'agent_a' as AgentId;
const B = 'agent_b' as AgentId;
const user: Principal = { kind: 'user', userId: 'owner', workspaceId: WS };
const agentA: Principal = { kind: 'agent', workspaceId: WS, agentId: A, sessionId: 'session_a' as SessionId };
const agentB: Principal = { kind: 'agent', workspaceId: WS, agentId: B, sessionId: 'session_b' as SessionId };
const machine: Principal = { kind: 'machine', workspaceId: WS, machineId: 'machine_1' as never };

const privateA = memoryActorKey(WS, `agent:${A}`);
const shared = memoryActorKey(WS, 'shared:team');

/** The four conformance features the flat plugin does not have (MEM-09: it reports the fields instead). */
const FLAT_WITHOUT: readonly MemoryFeature[] = ['conditions', 'kindWeights', 'ttl', 'supersedes'];

const fact = { kind: 'fact' as const, text: 'the team deploys on fridays', tags: ['deploy'], confidence: 'stated' as const, provenance: { source: 'agent' as const } };
const status = (error: unknown): number | undefined => (isServerFnError(error) ? error.status : undefined);

let host: Host | null = null;
let restore: (() => void) | undefined;
let current: Principal | null = user;
const as = (p: Principal | null) => (current = p);

async function start(storage = memoryStorage()): Promise<Host> {
    restore ??= stubServerApp({ authenticate: () => current, codec: { encode: (p) => JSON.stringify(p), decode: (s) => (s ? (JSON.parse(s) as Principal) : null) } });
    host = createHost({ actors: [Memory, FlatMemory], storage, defaults: quiet });
    await host.start();
    return host;
}

async function stop(): Promise<void> {
    await host?.stop();
    host = null;
    restore?.();
    restore = undefined;
    current = user;
}

describe('memoryConformance: FlatMemory actor over memoryStorage()', () => {
    beforeAll(() => start());
    afterAll(stop);

    // A small wire batch so the export/import cases cross page boundaries.
    const make = (scope: MemoryScope) => actorMemoryStore(actor(FlatMemory, memoryActorKey(WS, scope)), 2);
    for (const c of memoryConformance(make, { without: FLAT_WITHOUT })) it(c.name, c.run);
});

describe('FlatMemory', () => {
    afterEach(stop);

    it('authorizes a scope exactly as the Memory actor does: the owner, the agent itself, nobody else', async () => {
        await start();
        as(agentA);
        const put = await actor(FlatMemory, privateA).put(fact);
        expect((await actor(FlatMemory, privateA).get(put.id))?.text).toBe(fact.text);

        as(agentB);
        expect(status(await actor(FlatMemory, privateA).get(put.id).catch((e: unknown) => e))).toBe(403);
        expect(status(await actor(FlatMemory, privateA).put(fact).catch((e: unknown) => e))).toBe(403);
        as(machine);
        expect(status(await actor(FlatMemory, privateA).get(put.id).catch((e: unknown) => e))).toBe(403);
        as(null);
        expect(status(await actor(FlatMemory, privateA).get(put.id).catch((e: unknown) => e))).toBe(401);
        as(user);
        expect((await actor(FlatMemory, privateA).get(put.id))?.id).toBe(put.id);
    });

    it('a shared scope obeys the ACL on its Memory actor: none → no agent; a read grant reads, and only reads', async () => {
        await start();
        as(user);
        await actor(FlatMemory, shared).put(fact);

        as(agentA);
        expect(status(await actor(FlatMemory, shared).query({ limit: 5 }).catch((e: unknown) => e))).toBe(403);
        expect(status(await actor(FlatMemory, shared).put(fact).catch((e: unknown) => e))).toBe(403);

        as(user);
        await actor(Memory, shared).setAcl({ read: [A], write: [] });
        expect(await actor(FlatMemory, shared).getAcl()).toEqual({ read: [A], write: [] });
        expect(await actor(FlatMemory, shared).stats()).toMatchObject({ entries: 1, live: 1, acl: { read: [A], write: [] } });

        as(agentA);
        expect((await actor(FlatMemory, shared).query({ limit: 5 })).map((r) => r.entry.text)).toEqual([fact.text]);
        expect(status(await actor(FlatMemory, shared).put(fact).catch((e: unknown) => e))).toBe(403);
        as(agentB);
        expect(status(await actor(FlatMemory, shared).query({ limit: 5 }).catch((e: unknown) => e))).toBe(403);

        // Granted write, and it writes.
        as(user);
        await actor(Memory, shared).setAcl({ read: '*', write: [B] });
        as(agentB);
        await actor(FlatMemory, shared).put({ ...fact, text: 'b was here' });
        as(user);
        expect((await actor(FlatMemory, shared).stats()).entries).toBe(2);
    });

    it('keeps its own records: the Memory actor of the same scope does not see them, nor they it', async () => {
        await start();
        as(user);
        await actor(Memory, privateA).put({ ...fact, text: 'default store' });
        await actor(FlatMemory, privateA).put({ ...fact, text: 'flat store' });
        expect((await actor(Memory, privateA).exportPage(null)).entries.map((e) => e.text)).toEqual(['default store']);
        expect((await actor(FlatMemory, privateA).exportPage(null)).entries.map((e) => e.text)).toEqual(['flat store']);
    });

    it('persists every mutation inside the turn: state survives a deactivation and a new host', async () => {
        const storage = memoryStorage();
        await start(storage);
        as(user);
        const client = actor(FlatMemory, privateA);
        const a = await client.put(fact);
        const b = await client.put({ ...fact, text: 'scratch' });
        await client.update(a.id, { text: 'the team deploys on thursdays' });
        await client.retire(b.id, 'done');
        await host!.deactivate({ type: 'FlatMemory', key: privateA });

        const again = actor(FlatMemory, privateA);
        expect((await again.get(a.id))?.text).toBe('the team deploys on thursdays');
        expect((await again.get(b.id))?.retired).toBe(true);
        expect(await again.stats()).toMatchObject({ entries: 2, live: 1, rev: 4 });

        await host!.stop();
        host = createHost({ actors: [Memory, FlatMemory], storage, defaults: quiet });
        await host.start();
        expect((await actor(FlatMemory, privateA).stats()).entries).toBe(2);
        expect(await actor(FlatMemory, privateA).delete(b.id)).toBe(true);
        await host.deactivate({ type: 'FlatMemory', key: privateA });
        expect(await actor(FlatMemory, privateA).get(b.id)).toBeUndefined();
    });

    it('as a plugin: partial export, and an import says what the flat shape dropped (MEM-09)', async () => {
        await start();
        as(user);
        const plugin = flatMemoryActorPlugin({ workspace: WS });
        expect(plugin).toMatchObject({ id: FLAT_MEMORY_PLUGIN_ID, capabilities: { semantic: false, export: 'partial' } });
        const store = plugin.open(`agent:${A}`, { now: Date.now, log: () => {} });
        async function* rows() {
            yield { id: 'mem_import_1', ...fact, provenance: { source: 'agent' as const, at: 1 }, conditions: 'on friday', evidence: ['run 1'] };
        }
        const report = await store.import(rows());
        expect(report).toEqual({ imported: 1, skipped: 0, droppedFields: ['conditions', 'evidence'] });
        const [kept] = await (async () => {
            const out = [];
            for await (const e of store.export()) out.push(e);
            return out;
        })();
        for (const f of FLAT_UNSUPPORTED_FIELDS) expect(kept).not.toHaveProperty(f);
        // Nothing expires in the flat plugin.
        expect(await actor(FlatMemory, privateA).compact()).toBe(0);
    });

    it('an import row whose id a record cannot hold is skipped, never written', async () => {
        await start();
        as(user);
        const report = await actor(FlatMemory, privateA).importBatch([{ id: '__proto__', ...fact, provenance: { source: 'agent', at: 1 } }]);
        expect(report).toMatchObject({ imported: 0, skipped: 1 });
        expect((await actor(FlatMemory, privateA).stats()).entries).toBe(0);
    });
});
