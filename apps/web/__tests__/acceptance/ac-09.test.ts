/**
 * AC-09 — A user corrects an agent and later starts a similar task. The
 * correction is retained with provenance and made available as relevant
 * context.
 *
 * The app's registry on the in-process host (`host.ts`), with the learning
 * ports the app wires (`platformLearningPorts` over `@agentic/learning`):
 * a task runs to its answer; the user corrects that answer through the
 * Session ("never do this"); the correction is a lesson in the agent's own
 * memory scope with the user's provenance; a similar task later opens a
 * session whose record carries the lesson in its retrieved memories and in
 * the platform-owned memory block of its system prompt. Deeper:
 * `packages/platform/__tests__/session-learning.test.ts` (repeated
 * corrections → a reviewed instruction proposal; the retrieval text and
 * the lesson's conditions when the open spec names the objective) and
 * `packages/learning/__tests__/plugin.test.ts`.
 *
 * Known gap, pinned by the `fails` case below: on the routed local path
 * the retrieved memories stop at the session record — `createSessionFactory`
 * builds the model agent from the config alone and never hands it
 * `spec.memories`, and `Routing.placeLocal` opens the session without the
 * task's objective, so the retrieval text is empty. Follow-up: #135.
 */
import type { MessageId, TaskId } from '@agentic/core';
import { Memory, PLATFORM_MEMORY_HEADING, memoryActorKey } from '@agentic/platform';
import { startHost, type AcceptanceHost, type Owner } from './host';

const OBJECTIVE_1 = 'Write the release notes for v2.0';
const OBJECTIVE_2 = 'Draft the release notes for v2.1';
const CORRECTION = 'Never mention internal ticket numbers in release notes';

let h: AcceptanceHost;
beforeEach(async () => {
    h = await startHost();
});
afterEach(async () => {
    await h.stop();
});

/** Task 1 to its answer, the correction, then task 2 — the scenario's three steps. */
async function correctThenRepeat(me: Owner) {
    const ada = await me.agent('Ada', { role: 'writer' });
    await me.createTask('t_notes_1', ada, { objective: OBJECTIVE_1 });
    await me.routing().run('t_notes_1' as TaskId);
    const first = await me.settled('t_notes_1');
    expect(first.status).toBe('completed');
    expect(first.result?.text).toBe(`echo: ${OBJECTIVE_1}`);
    const session1 = me.session(first.sessionId!);
    // Nothing was there to inject yet; the record says where memory was looked for.
    expect((await session1.get()).spec?.memories).toEqual([]);
    expect((await session1.get()).spec?.retrieval).toMatchObject({ scopes: [`agent:${ada}`], skipped: [] });

    const answer = (await session1.transcript())!.messages.filter((m) => m.role === 'assistant').at(-1)!;
    const result = await session1.correct(answer.id as MessageId, CORRECTION, 'never');

    await me.createTask('t_notes_2', ada, { objective: OBJECTIVE_2 });
    await me.routing().run('t_notes_2' as TaskId);
    const second = await me.settled('t_notes_2');
    expect(second.status).toBe('completed');
    return { ada, first, second, answer, result, session1 };
}

describe('AC-09: a correction, then a similar task', () => {
    it('retains the correction with provenance and puts it into the next similar session’s record as platform-owned context', async () => {
        const me = h.user('ac09_user');
        const { ada, first, second, answer, result, session1 } = await correctThenRepeat(me);

        // The correction is recorded on the session that received it, by the user, about that message.
        expect(result.correction).toMatchObject({ agentId: ada, sessionId: first.sessionId, messageId: answer.id, text: CORRECTION, what: 'never', by: 'user' });
        expect(result.proposals.map((p) => p.kind)).toEqual(['memory']);
        expect((await session1.get()).corrections).toMatchObject([{ messageId: answer.id, what: 'never', by: 'user', written: 1, parked: 0 }]);

        // Retained in the agent's own scope, with provenance: who said it, in which session, about which message.
        const lessons = await h.as(me.principal).actor(Memory, memoryActorKey(me.ws, `agent:${ada}`)).query({ kinds: ['lesson'], limit: 10 });
        expect(lessons).toHaveLength(1);
        expect(lessons[0]!.entry).toMatchObject({
            kind: 'lesson',
            text: CORRECTION,
            confidence: 'stated',
            tags: ['correction', 'correction:never'],
            provenance: { source: 'user', sessionId: first.sessionId, messageId: answer.id }
        });
        expect(lessons[0]!.entry.evidence?.[0]).toMatch(/^correction\(never\) by user at .* in session_/);

        // The similar task later: the lesson is retrieved into the session and labelled as platform-owned context in its system block.
        const info2 = await me.session(second.sessionId!).get();
        expect(info2.spec?.memories?.map((m) => m.kind)).toEqual(['lesson', 'record']);
        expect(info2.spec?.memories?.[0]).toMatchObject({ text: CORRECTION, provenance: { source: 'user', sessionId: first.sessionId } });
        expect(info2.spec?.retrieval).toMatchObject({ scopes: [`agent:${ada}`], skipped: [] });
        const system = info2.spec?.system ?? '';
        expect(system).toContain(PLATFORM_MEMORY_HEADING);
        expect(system).toContain(`- lesson/stated: ${CORRECTION} [correction, correction:never]`);
        // The record of task 1 is in scope too, ranked below the lesson, and never mistaken for the runtime's own memory.
        expect(system).not.toMatch(/^## Memory$/m);
    });

    it.fails('the retrieved lesson reaches the model on the routed local path (open gap, #135)', async () => {
        const me = h.user('ac09_gap');
        const { second } = await correctThenRepeat(me);
        const info2 = await me.session(second.sessionId!).get();
        // The Routing opens the local session without the task's objective, so the retrieval text is empty…
        expect(info2.spec?.retrieval?.text).toBe(OBJECTIVE_2);
        // …and the model agent is built from the config alone: no request the model saw carried the lesson.
        expect(h.model!.requests.some((r) => r.system?.includes(CORRECTION))).toBe(true);
    });
});
