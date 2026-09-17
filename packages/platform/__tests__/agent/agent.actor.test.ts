/**
 * The Agent actor's contract (issue #15): identity across restarts, a
 * versioned and reversible config, and session snapshots that never move.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { actor } from '@sigx/actors';
import { isServerFnError } from '@sigx/server';
import type { AgentId, FrozenAgentConfig, Principal } from '@agentic/core';
import { AgentActor, agentKey, principalLabel } from '@agentic/platform';
import { OTHER_WS, WS, alice, startHarness, type Harness } from './harness';

const ID = 'agent_1' as AgentId;
const KEY = agentKey(WS, ID);

let h: Harness;

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_700_000_000_000);
    h = await startHarness([AgentActor]);
});

afterEach(async () => {
    await h.stop();
    vi.useRealTimers();
});

const status = (error: unknown): number | undefined => (isServerFnError(error) ? error.status : undefined);

/** The content of a snapshot, version stamp aside. */
const content = ({ configVersion: _v, ...rest }: FrozenAgentConfig) => rest;

describe('Agent actor', () => {
    it('is keyed {ws}:agent:{id} and starts unconfigured with its private memory scope', async () => {
        expect(KEY).toBe('ws_test:agent:agent_1');
        const view = await actor(AgentActor, KEY).get();
        expect(view.id).toBe(ID);
        expect(view.workspaceId).toBe(WS);
        expect(view.configVersion).toBe(0);
        expect(view.memoryScope).toBe('agent:agent_1');
        expect(view.config.memoryPolicy).toEqual({ shared: [], autoLearn: 'lessons' });
    });

    it('three updates then rollback to v1 yields a snapshot equal to the v1 snapshot', async () => {
        const a = actor(AgentActor, KEY);
        await a.update({ name: 'Ada', instructions: 'Review PRs.', tools: [{ name: 'git.diff' }] }, 'create');
        const v1 = await a.snapshotForSession();
        expect(v1.configVersion).toBe(1);

        await a.update({ instructions: 'Review PRs harshly.' }, 'tone');
        await a.update({ tools: [{ name: 'git.diff' }, { name: 'shell', mode: 'ask' }] }, 'more tools');
        await a.update({ skills: [{ id: 'security-review' }], memoryPolicy: { shared: ['shared:team'] } }, 'skills');
        const v4 = await a.snapshotForSession();
        expect(v4.configVersion).toBe(4);
        expect(content(v4)).not.toEqual(content(v1));

        const rolled = await a.rollback(1);
        expect(rolled).toEqual({ version: 5, at: 1_700_000_000_000, by: 'user:alice', reason: 'rollback to v1', rollbackOf: 1 });

        const v5 = await a.snapshotForSession();
        expect(v5.configVersion).toBe(5);
        expect(content(v5)).toEqual(content(v1));
        // History is untouched: the rollback is itself a version, so it can be undone.
        expect((await a.listVersions()).map((v) => v.version)).toEqual([1, 2, 3, 4, 5]);
        await a.rollback(4, 'undo the rollback');
        expect(content(await a.snapshotForSession())).toEqual(content(v4));
    });

    it('a snapshot taken before an update is unchanged after it (AGT-07)', async () => {
        const a = actor(AgentActor, KEY);
        await a.update({ name: 'Ada', instructions: 'v1', skills: [{ id: 's1' }] }, 'create');
        const before = await a.snapshotForSession();
        const frozen = structuredClone(before);

        await a.update({ instructions: 'v2', skills: [{ id: 's1' }, { id: 's2' }] }, 'edit');

        expect(before).toEqual(frozen);
        expect(before.configVersion).toBe(1);
        const after = await a.snapshotForSession();
        expect(after.configVersion).toBe(2);
        expect(after.instructions).toBe('v2');
        // and the snapshot is detached from actor state, not a live view of it
        (before.skills as { id: string }[]).push({ id: 'tampered' });
        expect((await a.get()).config.skills).toEqual([{ id: 's1' }, { id: 's2' }]);
    });

    it('every version keeps by, at and reason', async () => {
        const a = actor(AgentActor, KEY);
        await a.update({ name: 'Ada' }, 'create');
        vi.setSystemTime(1_700_000_001_000);
        h.signIn({ kind: 'agent', workspaceId: WS, agentId: 'agent_9' as AgentId, sessionId: 's1' as never });
        await a.update({ instructions: 'learned' }, 'reviewed instruction proposal');
        vi.setSystemTime(1_700_000_002_000);
        h.signIn({ kind: 'external', workspaceId: WS, clientId: 'cli', scopes: ['agents'] });
        await a.rollback(1);

        expect(await a.listVersions()).toEqual([
            { version: 1, at: 1_700_000_000_000, by: 'user:alice', reason: 'create' },
            { version: 2, at: 1_700_000_001_000, by: 'agent:agent_9', reason: 'reviewed instruction proposal' },
            { version: 3, at: 1_700_000_002_000, by: 'external:cli', reason: 'rollback to v1', rollbackOf: 1 }
        ]);
    });

    it('refuses an empty reason, an unknown field, a bad rollback target — nothing is recorded', async () => {
        const a = actor(AgentActor, KEY);
        await a.update({ name: 'Ada' }, 'create');
        await expect(a.update({ name: 'x' }, '')).rejects.toThrow(/reason/);
        await expect(a.update({ nickname: 'x' } as never, 'typo')).rejects.toThrow(/unknown agent config field "nickname"/);
        await expect(a.update('nope' as never, 'typo')).rejects.toThrow(TypeError);
        await expect(a.rollback(0)).rejects.toThrow(RangeError);
        await expect(a.rollback(2)).rejects.toThrow(RangeError);
        expect((await a.listVersions()).length).toBe(1);
        expect((await a.get()).config.name).toBe('Ada');
    });

    it('has no session snapshot before its first version', async () => {
        await expect(actor(AgentActor, KEY).snapshotForSession()).rejects.toThrow(/no configuration yet/);
    });

    it('keeps skills apart from tool grants: a skill never widens tools[] (AGT-04, LRN-08)', async () => {
        const a = actor(AgentActor, KEY);
        await a.update({ tools: [{ name: 'fs.read' }] }, 'create');
        await a.update({ skills: [{ id: 'deploy-prod' }] }, 'learned a skill');
        const snap = await a.snapshotForSession();
        expect(snap.skills).toEqual([{ id: 'deploy-prod' }]);
        expect(snap.tools).toEqual([{ name: 'fs.read' }]);
    });

    it('persists identity and every version across a host restart with no process in between (AGT-01/08)', async () => {
        await actor(AgentActor, KEY).update({ name: 'Ada', execution: { runtime: 'claude-code' } }, 'create');
        await actor(AgentActor, KEY).update({ role: 'reviewer' }, 'role');
        const storage = h.storage;
        await h.stop();

        h = await startHarness([AgentActor], { storage });
        const a = actor(AgentActor, KEY);
        const view = await a.get();
        expect(view.id).toBe(ID);
        expect(view.configVersion).toBe(2);
        expect(view.config.name).toBe('Ada');
        expect(view.config.execution.runtime).toBe('claude-code');
        expect((await a.listVersions()).map((v) => v.reason)).toEqual(['create', 'role']);
        await a.rollback(1);
        expect((await a.get()).config.role).toBe('');
    });

    it('is reachable only from its own workspace, and by external clients with the agents scope', async () => {
        await actor(AgentActor, KEY).update({ name: 'Ada' }, 'create');

        h.signIn({ kind: 'user', userId: 'bob', workspaceId: OTHER_WS });
        expect(status(await actor(AgentActor, KEY).get().catch((e: unknown) => e))).toBe(403);
        expect(status(await actor(AgentActor, agentKey(OTHER_WS, ID)).get().catch((e: unknown) => e))).toBeUndefined();

        h.signIn({ kind: 'external', workspaceId: WS, clientId: 'cli', scopes: ['chats'] });
        expect(status(await actor(AgentActor, KEY).get().catch((e: unknown) => e))).toBe(403);

        h.signIn(null);
        expect(status(await actor(AgentActor, KEY).get().catch((e: unknown) => e))).toBe(401);

        h.signIn(alice);
        expect((await actor(AgentActor, KEY).get()).config.name).toBe('Ada');
    });
});

describe('principalLabel', () => {
    it('names every principal kind and falls back to system', () => {
        const cases: [Principal | null | undefined, string][] = [
            [alice, 'user:alice'],
            [{ kind: 'machine', workspaceId: WS, machineId: 'm1' as never }, 'machine:m1'],
            [{ kind: 'external', workspaceId: WS, clientId: 'c', scopes: [] }, 'external:c'],
            [null, 'system'],
            [undefined, 'system']
        ];
        for (const [p, label] of cases) expect(principalLabel(p)).toBe(label);
    });
});
