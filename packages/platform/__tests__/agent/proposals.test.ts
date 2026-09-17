/**
 * The Agent actor's review queue (LRN-08): learning parks instruction
 * proposals, a user accepts or rejects them, an acceptance is a new
 * reversible config version, and the log replays.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentId, Principal, SessionId, WorkspaceId } from '@agentic/core';
import { AgentActor, agentKey, applyAgentEntry, initialAgentState, type ProposalOrigin } from '../../src/agent/index';
import { statusOf, testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const WS = 'u1' as WorkspaceId;
const AGENT = 'agent_1' as AgentId;
const OTHER = 'agent_2' as AgentId;
const KEY = agentKey(WS, AGENT);
const owner = userPrincipal('u1');
const self: Principal = { kind: 'agent', workspaceId: WS, agentId: AGENT, sessionId: 'session_1' as SessionId };
const other: Principal = { kind: 'agent', workspaceId: WS, agentId: OTHER, sessionId: 'session_2' as SessionId };

const origin: ProposalOrigin = { kind: 'correction', sessionId: 'session_1' as SessionId, messageId: 'msg_1' as never };
const proposal = (patch: string) => ({ kind: 'instruction' as const, patch, reason: 'repeated 3 times', requiresReview: true as const });

let app: TestActorApp;
beforeEach(() => {
    app = testActorApp([AgentActor]);
    return app.start();
});
afterEach(() => app.stop());

const agent = (principal: Principal | null = owner) => app.as(principal).actor(AgentActor, KEY);

describe('Agent proposals', () => {
    it('parks instruction proposals, once per patch, and counts them on the view', async () => {
        const parked = await agent(self).propose([proposal('Never: mention ticket numbers'), proposal('Prefer: short sentences')], origin);
        expect(parked.map((p) => p.id)).toEqual(['prop_1', 'prop_2']);
        expect(parked[0]).toMatchObject({ proposal: proposal('Never: mention ticket numbers'), origin, by: 'agent:agent_1', status: 'pending' });
        const again = await agent(self).propose([proposal('  Never: mention ticket numbers ')], { ...origin, sessionId: 'session_3' as SessionId });
        expect(again).toEqual([parked[0]]);
        expect(await agent().listProposals()).toHaveLength(2);
        expect((await agent().get()).pendingProposals).toBe(2);
        expect((await agent().get()).configVersion).toBe(0);
    });

    it('refuses memory proposals, malformed instructions and a bad origin', async () => {
        await expect(agent().propose([{ kind: 'memory', entry: {} } as never], origin)).rejects.toThrow(/not an instruction proposal/);
        await expect(agent().propose([{ ...proposal('x'), requiresReview: false } as never], origin)).rejects.toThrow(/must require review/);
        await expect(agent().propose([proposal('   ')], origin)).rejects.toThrow(/needs a patch/);
        await expect(agent().propose([proposal('x')], { kind: 'task-end' } as never)).rejects.toThrow(/needs an origin/);
        expect(await agent().listProposals()).toEqual([]);
    });

    it('accepts as a new config version — reversible — or rejects; either leaves the queue', async () => {
        await agent().update({ instructions: 'Be brief.' }, 'initial');
        const [p1, p2] = await agent(self).propose([proposal('Never: mention ticket numbers'), proposal('Prefer: short sentences')], origin);

        const accepted = await agent().reviewProposal(p1!.id, 'accept');
        expect(accepted).toMatchObject({ id: 'prop_1', status: 'accepted', review: { by: 'user:u1', version: 2 } });
        const view = await agent().get();
        expect(view.configVersion).toBe(2);
        expect(view.config.instructions).toBe('Be brief.\n\nNever: mention ticket numbers');
        expect((await agent().listVersions()).at(-1)).toMatchObject({ version: 2, reason: 'accepted proposal prop_1: repeated 3 times' });

        const rejected = await agent().reviewProposal(p2!.id, 'reject', 'too broad');
        expect(rejected).toMatchObject({ id: 'prop_2', status: 'rejected', review: { by: 'user:u1', reason: 'too broad' } });
        expect(rejected.review?.version).toBeUndefined();
        expect((await agent().get()).configVersion).toBe(2);
        expect(await agent().listProposals('pending')).toEqual([]);
        expect((await agent().listProposals('accepted')).map((p) => p.id)).toEqual(['prop_1']);

        // Reviewed twice is an error, and the rollback of an accepted proposal is an ordinary rollback (AGT-06).
        await expect(agent().reviewProposal(p1!.id, 'reject')).rejects.toThrow(/already accepted/);
        await expect(agent().reviewProposal('prop_9', 'accept')).rejects.toThrow(/no agent proposal prop_9/);
        await agent().rollback(1);
        expect((await agent().get()).config.instructions).toBe('Be brief.');
    });

    it('lets an agent propose only for itself and only users review', async () => {
        expect(await statusOf(agent(other).propose([proposal('x')], origin))).toBe(403);
        expect(await statusOf(agent(self).propose([proposal('x')], origin))).toBeUndefined();
        expect(await statusOf(agent(self).reviewProposal('prop_1', 'accept'))).toBe(403);
        const machine: Principal = { kind: 'machine', workspaceId: WS, machineId: 'machine_1' as never };
        expect(await statusOf(agent(machine).propose([proposal('y')], origin))).toBe(403);
        expect(await statusOf(agent(userPrincipal('u2')).reviewProposal('prop_1', 'accept'))).toBe(403);
        expect(await statusOf(agent().reviewProposal('prop_1', 'accept'))).toBeUndefined();
    });

    it('replays: the queue survives a deactivation and the reducer refuses an inconsistent log', async () => {
        await agent(self).propose([proposal('x')], origin);
        await agent().reviewProposal('prop_1', 'reject');
        const before = await agent().listProposals();
        await app.host.deactivate({ type: 'Agent', key: KEY });
        expect(await agent().listProposals()).toEqual(before);

        const state = initialAgentState(KEY);
        applyAgentEntry(state, { t: 'proposal', id: 'p', proposal: proposal('x'), origin, by: 'agent:agent_1', at: 1 });
        expect(() => applyAgentEntry(state, { t: 'proposal', id: 'p', proposal: proposal('x'), origin, by: 'agent:agent_1', at: 1 })).toThrow(/already exists/);
        expect(() => applyAgentEntry(state, { t: 'review', id: 'q', decision: 'accept', by: 'user:u1', at: 2 })).toThrow(/no agent proposal q/);
        applyAgentEntry(state, { t: 'review', id: 'p', decision: 'reject', by: 'user:u1', at: 2 });
        expect(() => applyAgentEntry(state, { t: 'review', id: 'p', decision: 'accept', by: 'user:u1', at: 3 })).toThrow(/already rejected/);
        expect(() => applyAgentEntry(state, { t: 'nope' } as never)).toThrow(/unknown agent entry "nope"/);
    });
});
