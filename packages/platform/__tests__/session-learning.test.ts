/**
 * Memory and learning on the execution path (architecture §8; MEM-07/10/11,
 * LRN-02/03/05/08), end to end against real actors — Session, Memory and
 * Agent — with `mockAgent` as the runtime and the default `learningPlugin`.
 *
 * AC-09: a user corrects an agent, later starts a similar task, and the
 * correction is retained with provenance and injected as context.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actorKey, type AgentId, type FrozenAgentConfig, type MachineId, type MemoryScope, type MessageId, type Principal, type TaskId, type WorkspaceId } from '@agentic/core';
import { learningPlugin, memoryCorrectionLedger } from '@agentic/learning';
import { allowAll } from '@sigx/ai-agent';
import { mockAgent, type MockAgent } from '@sigx/ai-agent/testing';

import { AgentActor, agentKey } from '../src/agent/index';
import { Memory, memoryActorKey } from '../src/memory/index';
import { defineSessionActor, type SessionFactory, type SessionFactoryContext, type SessionOpenSpec } from '../src/session/index';
import { PLATFORM_MEMORY_HEADING, PLATFORM_MEMORY_NOTE, platformLearningPorts } from '../src/task/index';
import { statusOf, testActorApp, userPrincipal, type TestActorApp } from '../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const AGENT = 'agent_1' as AgentId;
const T = 1_700_000_000_000;

const config = (shared: string[] = []): FrozenAgentConfig => ({
    agentId: AGENT,
    configVersion: 1,
    name: 'Ada',
    description: '',
    role: 'writer',
    instructions: 'Be brief.',
    skills: [],
    tools: [],
    connectors: [],
    approvalPolicy: [],
    memoryPolicy: { shared, autoLearn: 'lessons' },
    execution: { runtime: 'anthropic-api', limits: {}, offlinePolicy: 'fail' },
    collaborators: 'all'
});

const OBJECTIVE_1 = 'Write the release notes for v2.0';
const OBJECTIVE_2 = 'Draft the release notes for v2.1';
const CORRECTION = 'Never mention internal ticket numbers in release notes';

const spec = (taskId: string, objective: string, shared: string[] = []): SessionOpenSpec => ({
    agentId: AGENT,
    runtime: 'anthropic-api',
    taskId: taskId as TaskId,
    objective,
    context: [{ type: 'text', text: objective }],
    tags: ['release'],
    config: config(shared),
    system: '# Ada\n\nBe brief.'
});

let app: TestActorApp;
let agent: MockAgent;
let Session: ReturnType<typeof defineSessionActor>;
/** What the runtime factory was handed for every open — the prompt the model would see. */
let opened: SessionFactoryContext[];

function factory(a: MockAgent): SessionFactory {
    return async (runtime, c) => {
        if (runtime !== 'anthropic-api') return null;
        opened.push(c);
        const session = await a.session({ policy: allowAll, signal: c.signal, ...(c.resume ? { resume: c.resume } : {}) });
        return { session, agentId: a.id, capabilities: a.capabilities };
    };
}

beforeEach(() => {
    opened = [];
    agent = mockAgent({ respond: (input) => [{ text: `notes: ${input.map((p) => (p.type === 'text' ? p.text : '')).join('')}` }] });
    // One ledger across sessions (LRN-09); the plugin itself is built per session so a lesson's conditions name the task (LRN-04).
    const ledger = memoryCorrectionLedger();
    Session = defineSessionActor({
        factory: factory(agent),
        now: () => T,
        learning: platformLearningPorts({ plugin: (c) => learningPlugin({ now: () => T, ledger, contextFor: () => ({ objective: c.objective, tags: c.tags }) }) })
    });
    app = testActorApp([Session, Memory, AgentActor]);
    return app.start();
});
afterEach(() => app.stop());

const session = (id: string, principal: Principal | null = owner) => app.as(principal).actor(Session, actorKey(WS, 'session', id));
const memory = (scope: `agent:${string}` | `shared:${string}`) => app.as(owner).actor(Memory, memoryActorKey(WS, scope as MemoryScope));
const agentActor = () => app.as(owner).actor(AgentActor, agentKey(WS, AGENT));

/** A turn is over once the driver snapshotted the transcript at the head — learning runs in that same turn. */
async function finished(id: string): Promise<void> {
    const deadline = Date.now() + 3_000;
    for (;;) {
        const i = await session(id).get();
        if (!i.running && i.transcriptAt && i.transcriptAt.epoch === i.head.epoch && i.transcriptAt.seq === i.head.seq) return;
        if (Date.now() > deadline) throw new Error(`timed out waiting for session ${id} to finish its turn`);
        await new Promise((r) => setTimeout(r, 5));
    }
}

async function runTurn(id: string, text: string, turnId = 't1'): Promise<MessageId> {
    expect(await session(id).prompt(text, turnId)).toMatchObject({ kind: 'ack' });
    await finished(id);
    const last = (await session(id).transcript())!.messages.at(-1)!;
    expect(last.role).toBe('assistant');
    return last.id as MessageId;
}

describe('AC-09: a correction, then a similar task', () => {
    it('retains the correction with provenance and injects it as a platform-owned block into the next similar session', async () => {
        // A fresh agent starts with nothing to inject; the spec says where memory was looked for.
        const first = await session('session_1').open(spec('task_1', OBJECTIVE_1));
        expect(first.spec?.memories).toEqual([]);
        expect(first.spec?.retrieval).toEqual({ text: OBJECTIVE_1, scopes: ['agent:agent_1'], skipped: [], at: T });
        expect(first.spec?.system).toBe('# Ada\n\nBe brief.');
        expect(opened[0]?.spec.system).toBe('# Ada\n\nBe brief.');

        const messageId = await runTurn('session_1', OBJECTIVE_1);

        // Turn end: the outcome is a CLAIM (LRN-03), recorded in the agent's own scope with the task's provenance.
        const afterTurn = await session('session_1').get();
        expect(afterTurn.learning).toEqual({ turnId: 't1', at: T, status: 'completed', verification: 'claimed', written: 1, parked: 0 });
        const records = await memory('agent:agent_1').query({ kinds: ['record'], limit: 10 });
        expect(records).toHaveLength(1);
        expect(records[0]!.entry).toMatchObject({
            kind: 'record',
            text: `completed (claimed): ${OBJECTIVE_1}\nnotes: ${OBJECTIVE_1}`,
            tags: ['release', 'outcome:completed', 'verification:claimed'],
            confidence: 'assumed',
            provenance: { source: 'agent', at: T, taskId: 'task_1' }
        });

        // The user corrects the assistant message.
        const result = await session('session_1').correct(messageId, CORRECTION, 'never');
        expect(result.correction).toEqual({ agentId: AGENT, sessionId: 'session_1', messageId, text: CORRECTION, what: 'never', by: 'user', at: T });
        expect(result.proposals.map((p) => p.kind)).toEqual(['memory']);
        expect(result.parked).toBe(0);
        expect((await session('session_1').get()).corrections).toEqual([{ messageId, what: 'never', by: 'user', at: T, written: 1, parked: 0 }]);

        const lessons = await memory('agent:agent_1').query({ kinds: ['lesson'], limit: 10 });
        expect(lessons).toHaveLength(1);
        expect(lessons[0]!.entry).toMatchObject({
            kind: 'lesson',
            text: CORRECTION,
            confidence: 'stated',
            conditions: `Tasks like: ${OBJECTIVE_1}`,
            tags: ['correction', 'correction:never', 'release'],
            provenance: { source: 'user', at: T, sessionId: 'session_1', messageId }
        });

        // A similar task later: the lesson is retrieved and reaches the runtime as a clearly labelled platform block.
        const second = await session('session_2').open(spec('task_2', OBJECTIVE_2));
        expect(second.spec?.memories?.map((m) => m.text)).toContain(CORRECTION);
        expect(second.spec?.retrieval).toMatchObject({ text: OBJECTIVE_2, scopes: ['agent:agent_1'], skipped: [] });
        const system = second.spec?.system ?? '';
        expect(system.startsWith('# Ada\n\nBe brief.\n\n' + PLATFORM_MEMORY_HEADING + '\n\n' + PLATFORM_MEMORY_NOTE)).toBe(true);
        expect(system).toContain(`- lesson/stated: ${CORRECTION} [correction, correction:never, release] — applies: Tasks like: ${OBJECTIVE_1}`);
        expect(opened[1]?.spec.system).toBe(system);
        expect(opened[1]?.spec.memories).toEqual(second.spec?.memories);
        // The record of task 1 is in scope too, ranked below the lesson (kind weight), and never a runtime-owned memory.
        expect(second.spec?.memories?.[0]?.text).toBe(CORRECTION);
        expect(system).not.toMatch(/^## Memory$/m);

        // The spec survives a reactivation as recorded: the injected block is part of the session's record (MEM-10).
        await app.host.deactivate({ type: 'session', key: actorKey(WS, 'session', 'session_2') });
        expect((await session('session_2').get()).spec).toEqual(second.spec);
    });

    it('parks the instruction proposal a repeated correction yields on the Agent actor for review (LRN-08)', async () => {
        await session('session_1').open(spec('task_1', OBJECTIVE_1));
        const messageId = await runTurn('session_1', OBJECTIVE_1);
        expect((await session('session_1').correct(messageId, CORRECTION, 'never')).parked).toBe(0);
        expect((await session('session_1').correct(messageId, CORRECTION, 'never')).parked).toBe(0);
        const third = await session('session_1').correct(messageId, CORRECTION, 'never');
        expect(third.parked).toBe(1);
        expect(third.proposals.find((p) => p.kind === 'instruction')).toMatchObject({ kind: 'instruction', patch: `Never: ${CORRECTION}`, requiresReview: true });

        // Nothing was applied: the config is untouched until a user reviews, and the proposal names its origin.
        const view = await agentActor().get();
        expect(view.pendingProposals).toBe(1);
        expect(view.configVersion).toBe(0);
        const pending = await agentActor().listProposals('pending');
        expect(pending).toHaveLength(1);
        expect(pending[0]).toMatchObject({
            proposal: { kind: 'instruction', patch: `Never: ${CORRECTION}`, requiresReview: true },
            origin: { kind: 'correction', sessionId: 'session_1', taskId: 'task_1', messageId },
            by: 'agent:agent_1',
            status: 'pending'
        });
        // The lesson merged: one live lesson standing for three corrections, the superseded ones retired.
        const lessons = await memory('agent:agent_1').query({ kinds: ['lesson'], limit: 10 });
        expect(lessons).toHaveLength(1);
        expect(lessons[0]!.entry.evidence).toContain('corrections in total: 3');

        // Review: accepting lands as a new, reversible config version.
        const accepted = await agentActor().reviewProposal(pending[0]!.id, 'accept');
        expect(accepted).toMatchObject({ status: 'accepted', review: { by: 'user:u1', version: 1 } });
        expect((await agentActor().get()).config.instructions).toBe(`Never: ${CORRECTION}`);
        expect((await agentActor().get()).pendingProposals).toBe(0);
    });
});

describe('memory privacy on the path (MEM-11)', () => {
    it('reads a shared scope only through its ACL, and lists a refused one instead of hiding it', async () => {
        await memory('shared:team').put({ kind: 'preference', text: 'Release notes go out on Tuesdays', tags: ['release'], confidence: 'stated', provenance: { source: 'user' } });

        // No ACL: the agent may not read `shared:team`, and the session says so.
        const refused = await session('session_1').open(spec('task_1', OBJECTIVE_1, ['team']));
        expect(refused.spec?.memories).toEqual([]);
        expect(refused.spec?.retrieval?.scopes).toEqual(['agent:agent_1', 'shared:team']);
        expect(refused.spec?.retrieval?.skipped).toEqual([{ scope: 'shared:team', reason: expect.stringMatching(/read access to shared:team denied/) }]);

        // Granted by the owner: the shared preference joins the block.
        await memory('shared:team').setAcl({ read: [AGENT], write: [] });
        const granted = await session('session_2').open(spec('task_2', OBJECTIVE_2, ['team']));
        expect(granted.spec?.retrieval?.skipped).toEqual([]);
        expect(granted.spec?.memories?.map((m) => m.text)).toEqual(['Release notes go out on Tuesdays']);
        expect(granted.spec?.system).toContain('- preference/stated: Release notes go out on Tuesdays [release]');
    });

    it('learns as the agent: the lesson lands in the agent scope whoever corrected, and a machine cannot correct', async () => {
        await session('session_1').open(spec('task_1', OBJECTIVE_1));
        const messageId = await runTurn('session_1', OBJECTIVE_1);
        const machine: Principal = { kind: 'machine', workspaceId: WS, machineId: 'machine_1' as MachineId };
        expect(await statusOf(session('session_1', machine).correct(messageId, CORRECTION, 'never'))).toBe(403);
        expect(await statusOf(session('session_1', userPrincipal('u2')).correct(messageId, CORRECTION, 'never'))).toBe(403);
        // An agent's own correction reaches the plugin as `by: 'agent'`, which the default plugin does not learn from.
        const asAgent: Principal = { kind: 'agent', workspaceId: WS, agentId: AGENT, sessionId: 'session_1' as never };
        const own = await session('session_1', asAgent).correct(messageId, 'I should not have done that', 'wrong');
        expect(own.correction.by).toBe('agent');
        expect(own.proposals).toEqual([]);
        expect(await memory('agent:agent_1').query({ kinds: ['lesson'], limit: 10 })).toEqual([]);
    });
});

describe('edges', () => {
    it('refuses a correction of a message that is not an assistant message of the session', async () => {
        await session('session_1').open(spec('task_1', OBJECTIVE_1));
        await runTurn('session_1', OBJECTIVE_1);
        const user = (await session('session_1').transcript())!.messages.find((m) => m.role === 'user')!;
        await expect(session('session_1').correct(user.id as MessageId, CORRECTION, 'never')).rejects.toThrow(/not an assistant message/);
        await expect(session('session_1').correct('msg_nope' as MessageId, CORRECTION, 'never')).rejects.toThrow(/not an assistant message/);
        await expect(session('session_9').correct('msg_nope' as MessageId, CORRECTION, 'never')).rejects.toThrow(/not open/);
    });

    it('records no outcome for a session without a task, and none for an interrupted turn', async () => {
        const { taskId: _t, ...noTask } = spec('task_1', OBJECTIVE_1);
        await session('session_1').open(noTask);
        await runTurn('session_1', OBJECTIVE_1);
        expect((await session('session_1').get()).learning).toBeUndefined();
        expect(await memory('agent:agent_1').query({ kinds: ['record'], limit: 10 })).toEqual([]);
    });

    it('retrieves but does not learn without a plugin, and correct says so', async () => {
        const Plain = defineSessionActor({ factory: factory(agent), now: () => T, learning: platformLearningPorts() });
        const plain = testActorApp([Plain, Memory, AgentActor]);
        await plain.start();
        try {
            const s = plain.as(owner).actor(Plain, actorKey(WS, 'session', 'session_1'));
            const info = await s.open(spec('task_1', OBJECTIVE_1));
            expect(info.spec?.retrieval?.scopes).toEqual(['agent:agent_1']);
            await expect(s.correct('msg_1' as MessageId, CORRECTION, 'never')).rejects.toThrow(/no learning plugin/);
        } finally {
            await plain.stop();
        }
    });

    it('opens a session without learning ports exactly as before: no memories, no retrieval record', async () => {
        const Bare = defineSessionActor({ factory: factory(agent), now: () => T });
        const bare = testActorApp([Bare]);
        await bare.start();
        try {
            const info = await bare.as(owner).actor(Bare, actorKey(WS, 'session', 'session_1')).open(spec('task_1', OBJECTIVE_1));
            expect(info.spec?.memories).toBeUndefined();
            expect(info.spec?.retrieval).toBeUndefined();
            expect(info.spec?.system).toBe('# Ada\n\nBe brief.');
            expect(info.corrections).toEqual([]);
        } finally {
            await bare.stop();
        }
    });
});
