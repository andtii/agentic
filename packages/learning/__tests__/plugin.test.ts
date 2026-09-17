import type { TaskId } from '@agentic/core';
import { DEFAULT_LEARNING_PLUGIN_ID, isoWeek, learningPlugin, memoryCorrectionLedger, relevantLessons } from '../src/index';
import { AGENT, correction, NOW, outcome, store } from './helpers';

const DEPLOY = { objective: 'Deploy the web app to Cloudflare staging', tags: ['deploy'] };

describe('learningPlugin: corrections', () => {
    it('declares its identity', () => {
        const plugin = learningPlugin();
        expect([plugin.id, plugin.version]).toEqual([DEFAULT_LEARNING_PLUGIN_ID, '0.1.0']);
    });

    it('a correction followed by a similar task context returns the lesson (AC-09)', async () => {
        const memory = store();
        const plugin = learningPlugin({ contextFor: () => DEPLOY });
        await plugin.onCorrection(correction('Run pnpm build before wrangler deploy, never deploy an unbuilt worker', { what: 'wrong' }), memory);
        // Unrelated work in the same scope must not crowd the lesson out.
        await memory.put({ kind: 'lesson', text: 'Prefer vitest globals in unit tests', tags: [], confidence: 'stated', provenance: { source: 'user' } });

        const hits = await relevantLessons(memory, { objective: 'deploy the docs site to Cloudflare' });
        expect(hits).toHaveLength(1);
        const lesson = hits[0]!.entry;
        expect(lesson).toMatchObject({
            kind: 'lesson',
            text: 'Run pnpm build before wrangler deploy, never deploy an unbuilt worker',
            conditions: 'Tasks like: Deploy the web app to Cloudflare staging',
            confidence: 'stated',
            provenance: { source: 'user', sessionId: 'session_1', at: NOW }
        });
        expect(lesson.tags).toEqual(expect.arrayContaining(['correction', 'correction:wrong', 'deploy']));
        expect(lesson.evidence).toEqual([expect.stringMatching(/^correction\(wrong\) by user at 2026-09-17T10:00:00\.000Z in session_1\/msg_\d+: Run pnpm build/)]);

        expect(await relevantLessons(memory, { objective: 'rename a column in the billing database' })).toEqual([]);
    });

    it('without context the lesson is found by its own wording', async () => {
        const memory = store();
        await learningPlugin().onCorrection(correction('Use British spelling in customer emails'), memory);
        const hits = await relevantLessons(memory, { objective: 'draft customer emails about the outage' });
        expect(hits.map((h) => h.entry.conditions)).toEqual(['Whenever this comes up again: Use British spelling in customer emails']);
    });

    it('ignores agent-detected corrections unless enabled, and then keeps them as assumptions', async () => {
        const memory = store();
        const c = correction('Quote file paths with spaces', { by: 'agent' });
        expect(await learningPlugin().onCorrection(c, memory)).toEqual([]);
        expect(await memory.query({ limit: 10 })).toEqual([]);

        const [p] = await learningPlugin({ acceptAgentCorrections: true }).onCorrection(c, memory);
        expect(p).toMatchObject({ kind: 'memory', entry: { confidence: 'assumed', provenance: { source: 'agent' } } });
    });

    it('a repeated correction supersedes the earlier lesson and accumulates evidence (LRN-06)', async () => {
        const memory = store();
        const plugin = learningPlugin();
        await plugin.onCorrection(correction('Always answer in Swedish when the user writes Swedish'), memory);
        const first = (await memory.query({ kinds: ['lesson'], limit: 10 }))[0]!.entry;
        const [p] = await plugin.onCorrection(correction('Always answer in Swedish when the user writes in Swedish'), memory);

        expect(p).toMatchObject({ kind: 'memory', entry: { supersedes: first.id } });
        const live = await memory.query({ kinds: ['lesson'], limit: 10 });
        expect(live).toHaveLength(1);
        expect(live[0]!.entry.evidence).toHaveLength(2);
        expect(live[0]!.entry.text).toBe('Always answer in Swedish when the user writes in Swedish');
        expect(await memory.get(first.id)).toMatchObject({ retired: true });
    });

    it('does not merge corrections of a different kind or with little overlap', async () => {
        const memory = store();
        const plugin = learningPlugin();
        await plugin.onCorrection(correction('Keep commit subjects under 72 characters', { what: 'prefer' }), memory);
        await plugin.onCorrection(correction('Keep commit subjects under 72 characters', { what: 'never' }), memory);
        await plugin.onCorrection(correction('Use tabs in the Makefile', { what: 'prefer' }), memory);
        expect(await memory.query({ kinds: ['lesson'], limit: 10 })).toHaveLength(3);
    });

    it('proposes a review-gated instruction when the user repeats a correction (LRN-08)', async () => {
        const memory = store();
        const ledger = memoryCorrectionLedger();
        const plugin = learningPlugin({ ledger, repeatThreshold: 3 });
        const say = () => plugin.onCorrection(correction('Never push directly to main', { what: 'never' }), memory);
        expect((await say()).map((p) => p.kind)).toEqual(['memory']);
        expect((await say()).map((p) => p.kind)).toEqual(['memory']);
        const third = await say();
        expect(third[1]).toEqual({
            kind: 'instruction',
            patch: 'Never: Never push directly to main',
            reason: `The user made this correction 3 times (3 corrections for this agent in ${isoWeek(NOW)}).`,
            requiresReview: true
        });
        // Memory is written, instructions are not applied anywhere: the store holds lessons only.
        const kinds = (await memory.query({ limit: 50 })).map((h) => h.entry.kind);
        expect(new Set(kinds)).toEqual(new Set(['lesson']));
    });

    it('counts corrections per agent per ISO week (LRN-09)', async () => {
        const memory = store();
        const ledger = memoryCorrectionLedger();
        const plugin = learningPlugin({ ledger });
        const week = 7 * 86_400_000;
        await plugin.onCorrection(correction('one thing', { what: 'wrong' }), memory);
        await plugin.onCorrection(correction('another thing', { what: 'prefer' }), memory);
        await plugin.onCorrection(correction('next week', { at: NOW + week }), memory);
        await plugin.onCorrection(correction('other agent', { agentId: 'agent_b' as typeof AGENT }), memory);
        expect(ledger.count(AGENT, isoWeek(NOW))).toBe(2);
        expect(ledger.count(AGENT, isoWeek(NOW), 'wrong')).toBe(1);
        expect(ledger.count(AGENT, isoWeek(NOW + week))).toBe(1);
        expect(ledger.count('agent_b' as typeof AGENT, isoWeek(NOW))).toBe(1);
    });

    it('with apply: false proposes without writing', async () => {
        const memory = store();
        const proposals = await learningPlugin({ apply: false }).onCorrection(correction('Prefer pnpm over npm'), memory);
        expect(proposals).toHaveLength(1);
        expect(await memory.query({ limit: 10 })).toEqual([]);
    });
});

describe('learningPlugin: task outcomes', () => {
    it('keeps claimed and verified success distinct (LRN-03)', async () => {
        const memory = store();
        const plugin = learningPlugin({ now: () => NOW });
        await plugin.onTaskEnd(outcome('Migrate the users table', { taskId: 'task_claimed' as TaskId, verification: 'claimed', result: { artifacts: [], verified: false } }), memory);
        await plugin.onTaskEnd(outcome('Migrate the orders table', { taskId: 'task_verified' as TaskId, verification: 'verified', result: { artifacts: [], verified: true, text: 'all rows copied' } }), memory);

        const records = (await memory.query({ kinds: ['record'], limit: 10 })).map((h) => h.entry);
        const claimed = records.find((r) => r.provenance.taskId === 'task_claimed')!;
        const verified = records.find((r) => r.provenance.taskId === 'task_verified')!;
        expect(claimed).toMatchObject({ confidence: 'assumed', provenance: { source: 'agent' }, text: 'completed (claimed): Migrate the users table' });
        expect(claimed.tags).toContain('verification:claimed');
        expect(verified).toMatchObject({ confidence: 'verified', provenance: { source: 'verification' }, text: 'completed (verified): Migrate the orders table\nall rows copied' });
        expect(verified.tags).toEqual(expect.arrayContaining(['outcome:completed', 'verification:verified']));
        expect(await memory.query({ kinds: ['lesson'], limit: 10 })).toEqual([]);
    });

    it('turns a refuted claim into a lesson for the next similar task', async () => {
        const memory = store();
        await learningPlugin({ now: () => NOW }).onTaskEnd(outcome('Upgrade the wrangler toolchain', { verification: 'refuted', tags: ['tooling'] }), memory);
        const hits = await relevantLessons(memory, { objective: 'upgrade wrangler in the docs worker' });
        expect(hits.map((h) => h.entry)).toEqual([
            expect.objectContaining({ kind: 'lesson', confidence: 'verified', conditions: 'Tasks like: Upgrade the wrangler toolchain', provenance: expect.objectContaining({ source: 'verification', taskId: 'task_1' }) })
        ]);
    });

    it('keeps one live record per task', async () => {
        const memory = store();
        const plugin = learningPlugin({ now: () => NOW });
        await plugin.onTaskEnd(outcome('Ship it', { status: 'failed', verification: 'none' }), memory);
        await plugin.onTaskEnd(outcome('Ship it', { status: 'completed', verification: 'verified' }), memory);
        const records = await memory.query({ kinds: ['record'], limit: 10 });
        expect(records.map((h) => h.entry.text)).toEqual(['completed (verified): Ship it']);
    });
});
