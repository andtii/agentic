import type { MemoryEntry, MemoryQuery, MemoryStore, RankedMemory } from '@agentic/core';
import { learningPlugin, mergeLesson, relevantLessons, retireLesson, similarity, supersedeLesson } from '../src/index';
import { correction, NOW, store } from './helpers';

const plugin = learningPlugin({ contextFor: () => ({ objective: 'Write the release notes for the web app' }) });

describe('retired lessons are never returned', () => {
    it('retireLesson hides a lesson from relevantLessons', async () => {
        const memory = store();
        await plugin.onCorrection(correction('Release notes list breaking changes first'), memory);
        const [hit] = await relevantLessons(memory, { objective: 'write release notes' });
        await retireLesson(memory, hit!.entry.id, 'the team changed the template');
        expect(await relevantLessons(memory, { objective: 'write release notes' })).toEqual([]);
        expect(await memory.get(hit!.entry.id)).toMatchObject({ retired: true });
    });

    it('supersedeLesson returns only the replacement', async () => {
        const memory = store();
        await plugin.onCorrection(correction('Release notes list breaking changes first'), memory);
        const [old] = await relevantLessons(memory, { objective: 'write release notes' });
        const next = await supersedeLesson(memory, old!.entry.id, {
            kind: 'lesson',
            text: 'Release notes open with a one-line summary, then breaking changes',
            tags: ['correction'],
            conditions: old!.entry.conditions!,
            evidence: ['review of #40'],
            confidence: 'stated',
            provenance: { source: 'user' }
        });
        expect(next.supersedes).toBe(old!.entry.id);
        const hits = await relevantLessons(memory, { objective: 'write release notes' });
        expect(hits.map((h) => h.entry.id)).toEqual([next.id]);
    });

    it('filters retired entries even when a store leaks them', async () => {
        const leaked: MemoryEntry = { id: 'mem_x', kind: 'lesson', text: 'release notes are optional', tags: [], confidence: 'stated', retired: true, provenance: { source: 'user', at: NOW } };
        const live: MemoryEntry = { ...leaked, id: 'mem_y', text: 'release notes are required', retired: undefined };
        const calls: MemoryQuery[] = [];
        const leaky = {
            query: async (q: MemoryQuery): Promise<readonly RankedMemory[]> => {
                calls.push(q);
                return [
                    { entry: leaked, score: 9 },
                    { entry: live, score: 1 }
                ];
            }
        } as unknown as MemoryStore;
        const hits = await relevantLessons(leaky, { objective: 'release notes' });
        expect(hits.map((h) => h.entry.id)).toEqual(['mem_y']);
        expect(calls[0]).toMatchObject({ kinds: ['lesson'] });
    });
});

describe('relevantLessons', () => {
    it('respects limit and byte budget and ignores empty objectives', async () => {
        const memory = store();
        for (const n of ['alpha', 'beta', 'gamma']) {
            await memory.put({ kind: 'lesson', text: `deploy lesson ${n} ${'x'.repeat(40)}`, tags: [], confidence: 'stated', provenance: { source: 'user' } });
        }
        expect(await relevantLessons(memory, { objective: 'deploy' }, { limit: 2 })).toHaveLength(2);
        expect(await relevantLessons(memory, { objective: 'deploy' }, { maxBytes: 60 })).toHaveLength(1);
        expect(await relevantLessons(memory, { objective: '  ' })).toEqual([]);
    });
});

describe('lesson helpers', () => {
    it('similarity is word-set Jaccard', () => {
        expect(similarity('Use the tabs', 'use tabs')).toBe(1);
        expect(similarity('alpha beta', 'beta gamma')).toBeCloseTo(1 / 3);
        expect(similarity('', 'x y')).toBe(0);
    });

    it('mergeLesson keeps the newest evidence within the cap and both conditions', () => {
        const prev: MemoryEntry = { id: 'mem_1', kind: 'lesson', text: 'a', tags: ['t1'], conditions: 'Tasks like: A', evidence: ['e1', 'e2', 'e3'], confidence: 'assumed', provenance: { source: 'agent', at: NOW } };
        const merged = mergeLesson(prev, { kind: 'lesson', text: 'b', tags: ['t2'], conditions: 'Tasks like: B', evidence: ['e4'], confidence: 'stated', provenance: { source: 'user' } }, 3);
        expect(merged).toMatchObject({ text: 'b', tags: ['t1', 't2'], conditions: 'Tasks like: A\nTasks like: B', evidence: ['e2', 'e3', 'e4'], confidence: 'stated', supersedes: 'mem_1' });
    });
});
