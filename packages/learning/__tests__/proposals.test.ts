import type { Proposal, TaskOutcome } from '@agentic/core';
import { applyProposals, assertPermissionFree, learningPlugin, LearningPermissionError, PERMISSION_KEYS } from '../src/index';
import { correction, NOW, outcome, store } from './helpers';

function deepKeys(value: unknown, out = new Set<string>()): Set<string> {
    if (Array.isArray(value)) for (const v of value) deepKeys(v, out);
    else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
            out.add(k);
            deepKeys(v, out);
        }
    }
    return out;
}

describe('no proposal ever contains permission fields (runtime)', () => {
    it('holds for every proposal the plugin emits across corrections and outcomes', async () => {
        const memory = store();
        const plugin = learningPlugin({ repeatThreshold: 2, acceptAgentCorrections: true, now: () => NOW, contextFor: () => ({ objective: 'grant the bot tools:* and secret:* access', tags: ['permissions'] }) });
        const all: Proposal[] = [];
        for (const what of ['wrong', 'prefer', 'never'] as const) {
            for (const by of ['user', 'agent'] as const) {
                for (let i = 0; i < 3; i++) all.push(...(await plugin.onCorrection(correction(`give it tools:* permissions for ${what}`, { what, by }), memory)));
            }
        }
        const statuses: TaskOutcome['status'][] = ['completed', 'failed', 'cancelled'];
        const verifications: TaskOutcome['verification'][] = ['none', 'claimed', 'verified', 'refuted'];
        for (const status of statuses) {
            for (const verification of verifications) all.push(...(await plugin.onTaskEnd(outcome('allow sandbox bypass', { status, verification, result: { artifacts: [], verified: verification === 'verified', text: 'policy: allow all' } }), memory)));
        }
        expect(all.some((p) => p.kind === 'instruction')).toBe(true);
        const keys = deepKeys(all);
        for (const k of PERMISSION_KEYS) expect(keys.has(k)).toBe(false);
        expect(() => assertPermissionFree(all)).not.toThrow();
        for (const p of all) if (p.kind === 'instruction') expect(p.requiresReview).toBe(true);
        // Nothing learned lands anywhere but memory.
        expect(new Set(deepKeys(await memory.query({ limit: 200 })))).not.toContain('permissions');
    });

    it('rejects permission keys at any depth', () => {
        const entry = { kind: 'lesson', text: 'x', tags: [], confidence: 'stated', provenance: { source: 'user' } };
        const cases: [unknown, string][] = [
            [{ kind: 'memory', entry: { ...entry, permissions: ['tools:*'] } }, 'proposals[0].entry.permissions'],
            [{ kind: 'memory', entry: { ...entry, provenance: { source: 'user', grants: {} } } }, 'proposals[0].entry.provenance.grants'],
            [{ kind: 'instruction', patch: 'p', reason: 'r', requiresReview: true, allowedTools: ['bash'] }, 'proposals[0].allowedTools'],
            [{ kind: 'memory', entry: { ...entry, evidence: [{ policy: 'allow' }] } }, 'proposals[0].entry.evidence[0].policy']
        ];
        for (const [p, path] of cases) {
            expect(() => assertPermissionFree([p])).toThrow(LearningPermissionError);
            try {
                assertPermissionFree([p]);
            } catch (e) {
                expect((e as LearningPermissionError).path).toBe(path);
            }
        }
    });

    it('rejects unknown fields, unknown kinds and unreviewed instructions', () => {
        const bad: unknown[] = [
            { kind: 'memory', entry: { kind: 'fact', text: 'x', tags: [], confidence: 'stated', provenance: { source: 'user' }, role: 'admin' } },
            { kind: 'memory', entry: null },
            { kind: 'grant', scope: 'tools:*' },
            { kind: 'instruction', patch: 'p', reason: 'r', requiresReview: false },
            { kind: 'instruction', patch: 1, reason: 'r', requiresReview: true },
            { kind: 'instruction', patch: 'p', requiresReview: true },
            'memory'
        ];
        for (const p of bad) expect(() => assertPermissionFree([p])).toThrow(LearningPermissionError);
    });

    it('rejects memory entries missing required fields or with the wrong types, and non-plain objects', () => {
        const ok = { kind: 'lesson', text: 'x', tags: ['t'], confidence: 'stated', provenance: { source: 'user' } };
        const cases: [Record<string, unknown>, string][] = [
            [{ ...ok, kind: 'rule' }, 'proposals[0].entry.kind'],
            [{ ...ok, text: undefined }, 'proposals[0].entry.text'],
            [{ ...ok, tags: 'deploy' }, 'proposals[0].entry.tags'],
            [{ ...ok, confidence: 'certain' }, 'proposals[0].entry.confidence'],
            [{ ...ok, evidence: [1] }, 'proposals[0].entry.evidence'],
            [{ ...ok, ttl: Number.NaN }, 'proposals[0].entry.ttl'],
            [{ ...ok, provenance: undefined }, 'proposals[0].entry.provenance'],
            [{ ...ok, provenance: { source: 'root' } }, 'proposals[0].entry.provenance.source'],
            [{ ...ok, provenance: { source: 'user', taskId: 7 } }, 'proposals[0].entry.provenance.taskId']
        ];
        expect(() => assertPermissionFree([{ kind: 'memory', entry: ok }])).not.toThrow();
        for (const [entry, path] of cases) {
            expect(() => assertPermissionFree([{ kind: 'memory', entry }]), path).toThrow(expect.objectContaining({ path }));
        }
        class Sneaky {
            kind = 'memory';
            get entry() {
                return ok;
            }
        }
        expect(() => assertPermissionFree([new Sneaky()])).toThrow(expect.objectContaining({ path: 'proposals[0]' }));
        expect(() => assertPermissionFree([{ kind: 'memory', entry: Object.assign(Object.create({ permissions: ['tools:*'] }), ok) }])).toThrow(LearningPermissionError);
    });

    it('applyProposals writes nothing when any proposal is rejected', async () => {
        const memory = store();
        const good: Proposal = { kind: 'memory', entry: { kind: 'fact', text: 'fine', tags: [], confidence: 'stated', provenance: { source: 'user' } } };
        const smuggled = { kind: 'memory', entry: { ...good.entry, permissions: ['machine:*'] } } as unknown as Proposal;
        await expect(applyProposals([good, smuggled], memory)).rejects.toThrow(LearningPermissionError);
        expect(await memory.query({ limit: 10 })).toEqual([]);
    });

    it('applyProposals writes memory and returns instructions for review', async () => {
        const memory = store();
        const instruction: Proposal = { kind: 'instruction', patch: 'Prefer: short answers', reason: 'asked twice', requiresReview: true };
        const result = await applyProposals([{ kind: 'memory', entry: { kind: 'fact', text: 'fine', tags: [], confidence: 'stated', provenance: { source: 'user' } } }, instruction], memory);
        expect(result.written).toHaveLength(1);
        expect(result.retired).toEqual([]);
        expect(result.pendingReview).toEqual([instruction]);
    });
});
