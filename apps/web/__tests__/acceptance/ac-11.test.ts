/**
 * AC-11 — A memory implementation is replaced. Supported data can migrate
 * through a defined path, with any limitations reported.
 *
 * The app's registry on the in-process host (`host.ts`): an agent's memory
 * scope on the platform's Memory actor, filled the way the platform fills
 * it (a correction's lesson with its provenance, plus every other kind),
 * migrates through `@agentic/memory`'s `migrate` into the `flat` plugin —
 * a dry run first, reporting exactly the fields that implementation cannot
 * keep, per kind — and back into another scope of the Memory actor,
 * losslessly. Deeper: `packages/memory/__tests__/migrate.test.ts` (the
 * report shape, conflicts, a target without a fidelity seam) and
 * `../workers/memory-conformance.test.ts` (the actor's export pages over
 * the wire on Durable Object storage).
 */
import type { MemoryEntry, MessageId, TaskId } from '@agentic/core';
import { createFlatMemoryStore, migrate, FLAT_UNSUPPORTED_FIELDS } from '@agentic/memory';
import { Memory, actorMemoryStore, memoryActorKey, type MemoryActorClient } from '@agentic/platform';
import { startHost, type AcceptanceHost } from './host';

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const x of it) out.push(x);
    return out;
}

let h: AcceptanceHost;
beforeEach(async () => {
    h = await startHost();
});
afterEach(async () => {
    await h.stop();
});

describe('AC-11: a memory implementation is replaced', () => {
    it('migrates an agent’s scope into the flat plugin with its limitations reported, and back without loss', async () => {
        const me = h.user('ac11_user');
        const ada = await me.agent('Ada');
        const scope = memoryActorKey(me.ws, `agent:${ada}`);
        const source = h.as(me.principal).actor(Memory, scope);

        // What the platform itself writes: a task's outcome record, then a correction's lesson with the user's provenance.
        await me.createTask('t_notes', ada, { objective: 'Write the release notes' });
        await me.routing().run('t_notes' as TaskId);
        const done = await me.settled('t_notes');
        const answer = (await me.session(done.sessionId!).transcript())!.messages.filter((m) => m.role === 'assistant').at(-1)!;
        await me.session(done.sessionId!).correct(answer.id as MessageId, 'Never mention ticket numbers', 'never');
        // …and the rest of the kinds, the way an agent's `memory_remember` would.
        await source.put({ kind: 'fact', text: 'Repo uses pnpm', tags: ['tooling'], subject: 'repo', confidence: 'verified', provenance: { source: 'user' } });
        await source.put({ kind: 'preference', text: 'Concise answers', tags: ['style'], confidence: 'stated', provenance: { source: 'user' } });
        await source.put({ kind: 'assumption', text: 'The daemon is on Windows', tags: [], confidence: 'assumed', provenance: { source: 'agent' } });
        await source.put({ kind: 'working', text: 'scratch', tags: [], confidence: 'assumed', provenance: { source: 'agent' }, ttl: 60_000 });
        const before = await collect(actorMemoryStore(source as unknown as MemoryActorClient).export());
        expect(before.map((e) => e.kind).sort()).toEqual(['assumption', 'fact', 'lesson', 'preference', 'record', 'working']);
        const lesson = before.find((e) => e.kind === 'lesson')!;
        expect(lesson.provenance).toMatchObject({ source: 'user', sessionId: done.sessionId, messageId: answer.id });
        expect(lesson.evidence?.length).toBe(1);

        // The defined path: a dry run says what the replacement cannot keep, per kind, before anything is written.
        const flat = createFlatMemoryStore();
        const dry = await migrate(actorMemoryStore(source as unknown as MemoryActorClient), flat, { dryRun: true });
        expect(flat.size).toBe(0);
        expect(dry).toMatchObject({ dryRun: true, entries: 6, imported: 6, skipped: 0, droppedFields: ['conditions', 'evidence', 'ttl'] });
        expect(dry.kinds.lesson?.droppedFields).toEqual(['conditions', 'evidence']);
        expect(dry.kinds.working?.droppedFields).toEqual(['ttl']);
        expect(dry.kinds.fact?.droppedFields).toEqual([]);
        for (const field of dry.droppedFields) expect(FLAT_UNSUPPORTED_FIELDS).toContain(field);

        // The real migration into the replacement.
        const wet = await migrate(actorMemoryStore(source as unknown as MemoryActorClient), flat);
        expect(wet).toEqual({ ...dry, dryRun: false });
        expect(flat.size).toBe(6);
        expect((await flat.query({ text: 'ticket', limit: 5 })).map((r) => r.entry.text)).toContain('Never mention ticket numbers');

        // And back onto the platform, into another scope of the Memory actor: nothing the flat plugin kept is lost.
        const targetScope = memoryActorKey(me.ws, 'shared:migrated');
        const target = actorMemoryStore(h.as(me.principal).actor(Memory, targetScope) as unknown as MemoryActorClient);
        const back = await migrate(flat, target);
        expect(back).toMatchObject({ dryRun: false, entries: 6, imported: 6, skipped: 0, droppedFields: [] });
        const restored = await collect(target.export());
        expect(restored.map((e) => e.id).sort()).toEqual(before.map((e) => e.id).sort());
        for (const original of before) {
            const { conditions: _c, evidence: _e, ttl: _t, ...kept } = original as MemoryEntry & { conditions?: string; evidence?: string[]; ttl?: number };
            expect(await target.get(original.id)).toEqual(kept);
        }
        // The lesson's provenance survived the round trip; what did not is exactly what the report said.
        const restoredLesson = await target.get(lesson.id);
        expect(restoredLesson?.provenance).toEqual(lesson.provenance);
        expect(restoredLesson?.evidence).toBeUndefined();
        // The source is untouched by the migration.
        expect((await collect(actorMemoryStore(source as unknown as MemoryActorClient).export())).map((e) => e.id).sort()).toEqual(before.map((e) => e.id).sort());
    });
});
