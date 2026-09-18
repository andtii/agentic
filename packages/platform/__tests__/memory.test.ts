/**
 * The Memory actor: scope authorization (MEM-04, MEM-11, AC-10), the shared
 * ACL, and persistence across a deactivation over `memoryStorage()`.
 */
import type { AgentId, MemoryScope, Principal, SessionId, WorkspaceId } from '@agentic/core';
import { actor, type AnyActorDefinition } from '@sigx/actors';
import { createHost, memoryStorage, type Host } from '@sigx/actors/host';
import { isServerFnError } from '@sigx/server';
import { stubServerApp } from '@sigx/server/testing';
import { aclAllows, actorMemoryStore, Memory, memoryActorKey, memoryActorPlugin, memoryKeyAllows, parseMemoryKey } from '../src/index';

const quiet = { sweepIntervalMs: 60_000, reminderTickMs: 60_000, callTimeoutMs: 0 };
const WS = 'ws_owner' as WorkspaceId;
const OTHER_WS = 'ws_other' as WorkspaceId;
const A = 'agent_a' as AgentId;
const B = 'agent_b' as AgentId;
const user: Principal = { kind: 'user', userId: 'owner', workspaceId: WS };
const agentA: Principal = { kind: 'agent', workspaceId: WS, agentId: A, sessionId: 'session_a' as SessionId };
const agentB: Principal = { kind: 'agent', workspaceId: WS, agentId: B, sessionId: 'session_b' as SessionId };
const machine: Principal = { kind: 'machine', workspaceId: WS, machineId: 'machine_1' as never };
const external: Principal = { kind: 'external', workspaceId: WS, clientId: 'c', scopes: ['memory'] };
const externalNoScope: Principal = { kind: 'external', workspaceId: WS, clientId: 'c', scopes: ['tasks'] };
const foreignUser: Principal = { kind: 'user', userId: 'x', workspaceId: OTHER_WS };

const privateA = memoryActorKey(WS, `agent:${A}`);
const shared = memoryActorKey(WS, 'shared:team');

const fact = { kind: 'fact' as const, text: 'the team deploys on fridays', tags: ['deploy'], confidence: 'stated' as const, provenance: { source: 'agent' as const } };
const status = (error: unknown): number | undefined => (isServerFnError(error) ? error.status : undefined);

describe('parseMemoryKey / memoryKeyAllows (static policy)', () => {
    it('parses workspace-prefixed memory keys only', () => {
        expect(parseMemoryKey(privateA)).toEqual({ workspace: WS, scope: `agent:${A}` });
        expect(parseMemoryKey(shared)).toEqual({ workspace: WS, scope: 'shared:team' });
        expect(parseMemoryKey('ws_x:chat:c1')).toBeNull();
        expect(parseMemoryKey('ws_x:memory:other:thing')).toBeNull();
        expect(parseMemoryKey('ws_x:memory:agent:')).toBeNull();
        expect(parseMemoryKey(':memory:agent:a')).toBeNull();
    });

    it('admits the owner, the agent itself, and any agent on a shared scope; denies the rest', () => {
        expect(memoryKeyAllows(user, privateA)).toBe(true);
        expect(memoryKeyAllows(external, privateA)).toBe(true);
        expect(memoryKeyAllows(agentA, privateA)).toBe(true);
        expect(memoryKeyAllows(agentB, privateA)).toBe(false);
        expect(memoryKeyAllows(agentB, shared)).toBe(true);
        expect(memoryKeyAllows(machine, shared)).toBe(false);
        expect(memoryKeyAllows(externalNoScope, shared)).toBe(false);
        expect(memoryKeyAllows(foreignUser, privateA)).toBe(false);
        expect(memoryKeyAllows(null, privateA)).toBe(false);
        expect(memoryKeyAllows(user, 'ws_owner:chat:c1')).toBe(false);
    });
});

describe('aclAllows (the in-turn half)', () => {
    const scope = 'shared:team' as MemoryScope;
    it('denies every agent on a shared scope without an ACL, owners always pass', () => {
        expect(aclAllows(agentA, scope, null, 'read')).toBe(false);
        expect(aclAllows(user, scope, null, 'write')).toBe(true);
        expect(aclAllows(external, scope, null, 'write')).toBe(true);
        expect(aclAllows(null, scope, { read: '*', write: '*' }, 'read')).toBe(false);
        expect(aclAllows(machine, scope, { read: '*', write: '*' }, 'read')).toBe(false);
    });

    it('grants by list or wildcard, per access', () => {
        const acl = { read: '*' as const, write: [A] };
        expect(aclAllows(agentB, scope, acl, 'read')).toBe(true);
        expect(aclAllows(agentB, scope, acl, 'write')).toBe(false);
        expect(aclAllows(agentA, scope, acl, 'write')).toBe(true);
    });

    it('never consults the ACL on a private scope', () => {
        expect(aclAllows(agentB, `agent:${A}`, { read: '*', write: '*' }, 'read')).toBe(false);
        expect(aclAllows(agentA, `agent:${A}`, null, 'write')).toBe(true);
    });
});

describe('Memory actor', () => {
    let host: Host | null = null;
    let restore: (() => void) | undefined;

    afterEach(async () => {
        await host?.stop();
        host = null;
        restore?.();
        restore = undefined;
    });

    let current: Principal | null = null;
    /** One stubbed app for the test; `as(p)` switches the caller between calls. */
    function stubApp(): void {
        restore = stubServerApp({
            authenticate: () => current,
            codec: { encode: (p) => JSON.stringify(p), decode: (s) => (s ? (JSON.parse(s) as Principal) : null) }
        });
    }
    const as = (p: Principal | null) => (current = p);

    async function start(storage = memoryStorage(), defs: readonly AnyActorDefinition[] = [Memory]) {
        stubApp();
        host = createHost({ actors: defs, storage, defaults: quiet });
        await host.start();
        return host;
    }

    it('AC-10: another agent cannot read a private scope, nor can it read a shared scope without an ACL', async () => {
        await start();
        as(agentA);
        const put = await actor(Memory, privateA).put(fact);
        expect(put.id).toMatch(/^mem_/);

        as(agentB);
        const denied = await actor(Memory, privateA).query({ text: 'deploys', limit: 5 }).catch((e: unknown) => e);
        expect(status(denied)).toBe(403);
        const deniedGet = await actor(Memory, privateA).get(put.id).catch((e: unknown) => e);
        expect(status(deniedGet)).toBe(403);

        // the shared scope: past the static gate, stopped by the missing ACL
        const sharedDenied = await actor(Memory, shared).query({ limit: 5 }).catch((e: unknown) => e);
        expect(status(sharedDenied)).toBe(403);
        const sharedWriteDenied = await actor(Memory, shared).put(fact).catch((e: unknown) => e);
        expect(status(sharedWriteDenied)).toBe(403);

        as(null);
        expect(status(await actor(Memory, privateA).get(put.id).catch((e: unknown) => e))).toBe(401);
        as(machine);
        expect(status(await actor(Memory, privateA).get(put.id).catch((e: unknown) => e))).toBe(403);
        as(foreignUser);
        expect(status(await actor(Memory, privateA).get(put.id).catch((e: unknown) => e))).toBe(403);
    });

    it('the user owns every scope; the shared ACL opens a scope per access', async () => {
        await start();
        as(user);
        await actor(Memory, shared).put(fact);
        expect(await actor(Memory, shared).getAcl()).toBeNull();
        await actor(Memory, shared).setAcl({ read: '*', write: [A] });

        as(agentB);
        expect((await actor(Memory, shared).query({ text: 'deploy', limit: 5 })).map((r) => r.entry.text)).toEqual([fact.text]);
        expect(status(await actor(Memory, shared).put(fact).catch((e: unknown) => e))).toBe(403);
        expect(status(await actor(Memory, shared).setAcl(null).catch((e: unknown) => e))).toBe(403);

        as(agentA);
        const mine = await actor(Memory, shared).put({ ...fact, text: 'written by a' });
        expect(mine.provenance.source).toBe('agent');

        as(user);
        await actor(Memory, shared).setAcl(null);
        as(agentB);
        expect(status(await actor(Memory, shared).query({ limit: 5 }).catch((e: unknown) => e))).toBe(403);
    });

    it('MEM-05/08: delete removes an entry for good, inside the turn, and only with write access', async () => {
        const storage = memoryStorage();
        await start(storage);
        as(agentA);
        const client = actor(Memory, privateA);
        const keep = await client.put(fact);
        const gone = await client.put({ ...fact, text: 'the team deploys on mondays' });

        as(agentB);
        expect(status(await actor(Memory, privateA).delete(gone.id).catch((e: unknown) => e))).toBe(403);

        as(agentA);
        expect(await client.delete(gone.id)).toBe(true);
        expect(await client.delete(gone.id)).toBe(false);
        expect(await client.get(gone.id)).toBeUndefined();
        expect((await client.query({ text: 'deploys', limit: 5 })).map((r) => r.entry.id)).toEqual([keep.id]);
        expect((await client.exportPage(null)).entries.map((e) => e.id)).toEqual([keep.id]);
        expect(await client.stats()).toMatchObject({ entries: 1, live: 1 });

        await host!.deactivate({ type: 'Memory', key: privateA });
        expect(await actor(Memory, privateA).get(gone.id)).toBeUndefined();
        expect((await actor(Memory, privateA).stats()).entries).toBe(1);
    });

    it('persists every mutation inside the turn: state survives a deactivation', async () => {
        const storage = memoryStorage();
        await start(storage);
        as(user);
        const client = actor(Memory, privateA);
        const a = await client.put(fact);
        const w = await client.put({ kind: 'working', text: 'scratch', tags: [], confidence: 'assumed', ttl: 60_000, provenance: { source: 'agent' } });
        await client.update(a.id, { text: 'the team deploys on thursdays' });
        await client.retire(w.id, 'done');
        await client.setAcl({ read: [B], write: [] });
        await host!.deactivate({ type: 'Memory', key: privateA });

        const again = actor(Memory, privateA);
        expect((await again.get(a.id))?.text).toBe('the team deploys on thursdays');
        expect((await again.get(w.id))?.retired).toBe(true);
        expect(await again.getAcl()).toEqual({ read: [B], write: [] });
        expect(await again.stats()).toMatchObject({ entries: 2, live: 1, rev: 5 });

        // and a second host over the same storage sees the same record
        await host!.stop();
        host = createHost({ actors: [Memory], storage, defaults: quiet });
        await host.start();
        expect((await actor(Memory, privateA).stats()).entries).toBe(2);
    });

    it('rejects a non-memory key at activation', async () => {
        await start();
        as(user);
        const err = await actor(Memory, 'ws_owner:memory:nope').get('x').catch((e: unknown) => e);
        expect(status(err)).toBe(403);
    });
});

describe('memoryActorPlugin / actorMemoryStore', () => {
    let host: Host | null = null;
    let restore: (() => void) | undefined;
    afterEach(async () => {
        await host?.stop();
        host = null;
        restore?.();
    });

    it('opens a store per scope over the actor and streams export in pages', async () => {
        restore = stubServerApp({ authenticate: () => user, codec: { encode: (p) => JSON.stringify(p), decode: (s) => (s ? (JSON.parse(s) as Principal) : null) } });
        host = createHost({ actors: [Memory], storage: memoryStorage(), defaults: quiet });
        await host.start();
        const plugin = memoryActorPlugin({ workspace: WS });
        expect(plugin.capabilities).toEqual({ semantic: false, export: 'full' });
        const store = plugin.open(`agent:${A}`, { now: Date.now, log: () => {} });
        const ids: string[] = [];
        for (let i = 0; i < 5; i++) ids.push((await store.put({ ...fact, text: `fact ${i}` })).id);
        const small = actorMemoryStore(actor(Memory, privateA), 2);
        const exported: string[] = [];
        for await (const e of small.export()) exported.push(e.id);
        expect(exported).toEqual([...ids].sort());
        const report = await small.import((async function* () {
            for (const e of await Promise.all(ids.map((id) => store.get(id)))) yield { ...e!, embedding: [1] } as never;
            yield { ...(await store.get(ids[0]!))!, id: 'mem_new' };
        })());
        expect(report).toEqual({ imported: 1, skipped: 5, droppedFields: ['embedding'] });
    });
});
