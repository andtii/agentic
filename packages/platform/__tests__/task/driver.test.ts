/**
 * The memory and learning steps of the driver (architecture §7, §8) over
 * in-memory stores: scope selection, the merged retrieval budget, the
 * platform-owned block, claimed-vs-verified outcomes and corrections.
 */
import { describe, expect, it } from 'vitest';
import type { AgentId, MemoryScope, MemoryStore, MessageId, Principal, SessionId, TaskId, WorkspaceId } from '@agentic/core';
import { createMemoryStore } from '@agentic/memory';
import {
    DEFAULT_RETRIEVAL_LIMIT,
    DEFAULT_RETRIEVAL_MAX_BYTES,
    PLATFORM_MEMORY_HEADING,
    PLATFORM_MEMORY_NOTE,
    correctionOf,
    instructionProposals,
    memoryScopesOf,
    renderMemoryBlock,
    retrievalQuery,
    retrievalText,
    retrieveMemories,
    taskOutcomeOf,
    turnStatusOf,
    verificationOf,
    withMemoryBlock
} from '../../src/task/index';

const WS = 'ws_1' as WorkspaceId;
const AGENT = 'agent_1' as AgentId;
const agent: Principal = { kind: 'agent', workspaceId: WS, agentId: AGENT, sessionId: 'session_1' as SessionId, taskId: 'task_1' as TaskId };
const T = 1_700_000_000_000;

const config = (shared: string[] = []) => ({ agentId: AGENT, memoryPolicy: { shared, autoLearn: 'lessons' as const } });

/** One in-memory store per scope; a scope in `refused` throws like the Memory actor's ACL does. */
function opener(refused: readonly MemoryScope[] = []) {
    const stores = new Map<MemoryScope, MemoryStore>();
    const seen: { scope: MemoryScope; principal: Principal }[] = [];
    const open = (scope: MemoryScope, principal: Principal): MemoryStore => {
        seen.push({ scope, principal });
        if (refused.includes(scope)) throw new Error(`memory: read access to ${scope} denied`);
        let store = stores.get(scope);
        if (!store) {
            store = createMemoryStore({ now: () => T });
            stores.set(scope, store);
        }
        return store;
    };
    const store = (name: string) => {
        const scope = name as MemoryScope;
        let s = stores.get(scope);
        if (!s) {
            s = createMemoryStore({ now: () => T });
            stores.set(scope, s);
        }
        return s;
    };
    return { open, store, seen };
}

describe('retrieval context', () => {
    it('keys on the objective and the latest user message, once when they are the same', () => {
        expect(retrievalText({ objective: 'Write release notes', context: [{ type: 'text', text: 'Write release notes' }] })).toBe('Write release notes');
        expect(retrievalText({ objective: 'Write release notes', context: [{ type: 'text', text: 'old' }, { type: 'image', mediaType: 'image/png' }, { type: 'text', text: ' for v2 ' }] })).toBe('Write release notes\nfor v2');
        expect(retrievalText({ context: [{ type: 'text', text: 'only the message' }] })).toBe('only the message');
        expect(retrievalText({})).toBe('');
    });

    it('queries the own scope first, then the declared shared scopes, normalised and deduplicated (MEM-11)', () => {
        expect(memoryScopesOf(config())).toEqual(['agent:agent_1']);
        expect(memoryScopesOf(config(['team', 'shared:team', 'shared:ops', 'agent:agent_1']))).toEqual(['agent:agent_1', 'shared:team', 'shared:ops']);
    });

    it('builds one bounded query: text, tags, limit and byte budget (MEM-07)', () => {
        expect(retrievalQuery({ objective: 'x', tags: ['a', ' '] })).toEqual({ text: 'x', tags: ['a'], limit: DEFAULT_RETRIEVAL_LIMIT, maxBytes: DEFAULT_RETRIEVAL_MAX_BYTES });
        expect(retrievalQuery({}, { limit: 3, maxBytes: 100 })).toEqual({ limit: 3, maxBytes: 100 });
    });
});

describe('retrieveMemories', () => {
    it('merges every readable scope under the agent principal, best first, within the budget', async () => {
        const m = opener();
        await m.store('agent:agent_1').put({ kind: 'lesson', text: 'release notes: never mention internal ticket numbers', tags: ['correction'], confidence: 'stated', provenance: { source: 'user' } });
        await m.store('agent:agent_1').put({ kind: 'fact', text: 'the office plant is a ficus', tags: [], confidence: 'verified', provenance: { source: 'agent' } });
        await m.store('shared:team').put({ kind: 'preference', text: 'release notes go out on Tuesdays', tags: ['release'], confidence: 'stated', provenance: { source: 'user' } });

        const r = await retrieveMemories(m.open, agent, config(['team']), { objective: 'write the release notes for v2' });
        expect(r.scopes).toEqual(['agent:agent_1', 'shared:team']);
        expect(r.skipped).toEqual([]);
        expect(m.seen.every((s) => s.principal === agent)).toBe(true);
        expect(r.hits.map((h) => h.scope)).toContain('shared:team');
        // The two entries about release notes outrank the plant, whatever scope they live in.
        expect(r.entries.slice(0, 2).map((e) => e.text).sort()).toEqual(['release notes go out on Tuesdays', 'release notes: never mention internal ticket numbers']);
        expect(r.text).toBe('write the release notes for v2');

        const capped = await retrieveMemories(m.open, agent, config(['team']), { objective: 'write the release notes for v2' }, { limit: 1 });
        expect(capped.entries).toHaveLength(1);
        const bytes = await retrieveMemories(m.open, agent, config(['team']), { objective: 'write the release notes for v2' }, { maxBytes: 40 });
        // "release notes go out on Tuesdays" (32 bytes) fits; the 52-byte lesson does not, and does not block the plant (27 bytes) either way.
        expect(bytes.entries.map((e) => e.text)).not.toContain('release notes: never mention internal ticket numbers');
        expect(bytes.entries.reduce((n, e) => n + e.text.length, 0)).toBeLessThanOrEqual(40);
    });

    it('lists a scope the agent may not read as skipped and keeps the rest (MEM-11, OPS-04)', async () => {
        const m = opener(['shared:secret']);
        await m.store('agent:agent_1').put({ kind: 'fact', text: 'own fact', tags: [], confidence: 'verified', provenance: { source: 'agent' } });
        const r = await retrieveMemories(m.open, agent, config(['secret']), { objective: 'fact' });
        expect(r.entries.map((e) => e.text)).toEqual(['own fact']);
        expect(r.skipped).toEqual([{ scope: 'shared:secret', reason: 'memory: read access to shared:secret denied' }]);
    });
});

describe('the platform-owned block (MEM-10)', () => {
    const lesson = { id: 'm1', kind: 'lesson' as const, text: 'Never mention ticket numbers', tags: ['correction', 'correction:never'], confidence: 'stated' as const, conditions: 'Tasks like: release notes\nWhenever asked', provenance: { source: 'user' as const, at: T } };
    const fact = { id: 'm2', kind: 'fact' as const, text: 'Deploys go through CI', tags: [], subject: 'deploys', confidence: 'verified' as const, provenance: { source: 'agent' as const, at: T } };

    it('is labelled as platform-owned, one line per entry with kind, confidence, tags and conditions', () => {
        const block = renderMemoryBlock([lesson, fact]);
        expect(PLATFORM_MEMORY_HEADING).toBe('## Platform memory'); // the literal the Claude Code driver relabels to
        expect(block.startsWith(`${PLATFORM_MEMORY_HEADING}\n\n${PLATFORM_MEMORY_NOTE}\n\n`)).toBe(true);
        expect(block).toContain('- lesson/stated: Never mention ticket numbers [correction, correction:never] — applies: Tasks like: release notes; Whenever asked');
        expect(block).toContain('- fact/verified (deploys): Deploys go through CI');
        expect(renderMemoryBlock([])).toBe('');
    });

    it('appends after the stable prefix, once', () => {
        const block = renderMemoryBlock([fact]);
        expect(withMemoryBlock(undefined, '')).toBeUndefined();
        expect(withMemoryBlock('# Ada\n\nBe brief.', '')).toBe('# Ada\n\nBe brief.');
        expect(withMemoryBlock(undefined, block)).toBe(block);
        const system = withMemoryBlock('# Ada\n\nBe brief.\n', block)!;
        expect(system).toBe(`# Ada\n\nBe brief.\n\n${block}`);
        expect(withMemoryBlock(system, block)).toBe(system);
    });
});

describe('task outcomes (LRN-03)', () => {
    it('maps stop reasons: limits complete, cancel cancels, error and refusal fail', () => {
        expect(['end_turn', 'max_tokens', 'max_turns'].map(turnStatusOf)).toEqual(['completed', 'completed', 'completed']);
        expect(turnStatusOf('cancelled')).toBe('cancelled');
        expect(turnStatusOf('error')).toBe('failed');
        expect(turnStatusOf('refusal')).toBe('failed');
    });

    it('keeps a claim a claim until a verification step speaks', () => {
        const claimed = { text: 'done', artifacts: [], verified: false };
        expect(verificationOf('completed', claimed)).toBe('claimed');
        expect(verificationOf('completed', { artifacts: [], verified: false })).toBe('none');
        expect(verificationOf('failed', claimed)).toBe('none');
        expect(verificationOf('completed', { ...claimed, verified: true })).toBe('verified');
        expect(verificationOf('completed', claimed, 'refuted')).toBe('refuted');

        const base = { taskId: 'task_1' as TaskId, agentId: AGENT, objective: 'ship it', tags: ['release'] };
        expect(taskOutcomeOf({ ...base, status: 'completed', result: claimed })).toEqual({ ...base, status: 'completed', result: claimed, verification: 'claimed' });
        expect(taskOutcomeOf({ ...base, status: 'completed', result: claimed, verdict: 'verified' })).toMatchObject({ result: { verified: true }, verification: 'verified' });
        expect(taskOutcomeOf({ ...base, status: 'cancelled' })).toEqual({ ...base, status: 'cancelled', verification: 'none' });
    });
});

describe('corrections', () => {
    const input = { agentId: AGENT, sessionId: 'session_1' as SessionId, messageId: 'msg_1' as MessageId, by: 'user' as const, at: T };

    it('builds a Correction and refuses empty text or an unknown kind', () => {
        expect(correctionOf({ ...input, text: '  Never do that  ', what: 'never' })).toEqual({ ...input, text: 'Never do that', what: 'never' });
        expect(() => correctionOf({ ...input, text: '  ', what: 'wrong' })).toThrow(/needs text/);
        expect(() => correctionOf({ ...input, text: 'x', what: 'maybe' as never })).toThrow(/unknown correction kind "maybe"/);
    });

    it('separates the review-gated instruction proposals (LRN-08)', () => {
        const instruction = { kind: 'instruction' as const, patch: 'Never: x', reason: 'r', requiresReview: true as const };
        const memory = { kind: 'memory' as const, entry: { kind: 'lesson' as const, text: 'x', tags: [], confidence: 'stated' as const, provenance: { source: 'user' as const } } };
        expect(instructionProposals([memory, instruction, memory])).toEqual([instruction]);
    });
});
