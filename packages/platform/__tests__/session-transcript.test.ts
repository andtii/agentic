/**
 * The `anthropic-api` transcript leaves the record (#397): what the runtime
 * saves through the Session's `TranscriptStore` lives whole in
 * `SessionTranscriptPage`s, so the model's own history on resume is bounded
 * by no record budget and its older tool outputs are never replaced by trim
 * markers; the record keeps only the bounded view.
 */
import { actorKey, type AgentId, type FrozenAgentConfig, type TaskId, type WorkspaceId } from '@agentic/core';
import { allowAll, createTranscript, type AgentTranscript, type TranscriptStore } from '@sigx/ai-agent';
import { mockAgent } from '@sigx/ai-agent/testing';

import { applySessionEntry, defineSessionActor, jsonBytes, pageMessages, SessionPage, SessionTranscriptPage, TRANSCRIPT_BYTES, TRANSCRIPT_PAGE_BYTES, transcriptPageKey, type SessionEntry, type SessionFactory, type SessionOpenSpec, type SessionState } from '../src/session/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const KEY = actorKey(WS, 'session', 'session_1');
const config: FrozenAgentConfig = {
    agentId: 'agent_1' as AgentId,
    configVersion: 1,
    name: 'Ada',
    description: '',
    role: 'assistant',
    instructions: 'Be brief.',
    skills: [],
    tools: [],
    connectors: [],
    approvalPolicy: [],
    memoryPolicy: { shared: [], autoLearn: 'off' },
    execution: { runtime: 'anthropic-api', limits: {}, offlinePolicy: 'fail' },
    collaborators: 'all'
};
const spec: SessionOpenSpec = { agentId: config.agentId, runtime: 'anthropic-api', taskId: 'task_1' as TaskId, config };

/** A transcript of `turns` turns, each an assistant message whose tool output weighs `outputBytes` — like a long coding session's. */
function transcriptOf(sessionId: string, turns: number, outputBytes: number): AgentTranscript {
    const t = createTranscript(sessionId);
    for (let i = 1; i <= turns; i++) {
        t.messages.push({ id: `u${i}`, role: 'user', turnId: `t${i}`, parts: [{ type: 'text', text: `turn ${i}` }] });
        t.messages.push({ id: `a${i}`, role: 'assistant', turnId: `t${i}`, parts: [{ type: 'tool', callId: `c${i}`, name: 'Read', status: 'completed', input: { path: `f${i}` }, output: `o${i}:`.padEnd(outputBytes, 'o') } as never, { type: 'text', id: `x${i}`, text: `answer ${i}` }] });
    }
    t.epoch = 1;
    t.seq = turns * 2;
    return t;
}

let app: TestActorApp;
let Session: ReturnType<typeof defineSessionActor>;
/** The store the factory was handed — what `modelAgent({ store })` saves through at every turn end and loads from on resume. */
let stores: TranscriptStore[];

beforeEach(() => {
    stores = [];
    const agent = mockAgent({ respond: () => [{ text: 'ok' }] });
    const factory: SessionFactory = async (runtime, c) => {
        if (runtime !== 'anthropic-api') return null;
        stores.push(c.transcripts);
        const session = await agent.session({ policy: allowAll, signal: c.signal, ...(c.resume ? { resume: c.resume } : {}) });
        return { session, agentId: agent.id, capabilities: agent.capabilities };
    };
    Session = defineSessionActor({ factory });
    app = testActorApp([Session, SessionPage, SessionTranscriptPage]);
    return app.start();
});
afterEach(() => app.stop());

const session = () => app.as(owner).actor(Session, KEY);

async function storedState(): Promise<{ state: SessionState; bytes: number }> {
    const record = await app.storage.load('session', KEY);
    const state = structuredClone(record!.state) as SessionState;
    for (const entry of record!.log ?? []) applySessionEntry(state, entry as SessionEntry);
    return { state, bytes: jsonBytes(record!.state) + jsonBytes(record!.log ?? []) };
}

const pageSaves = () => app.saves.filter((s) => s.type === 'session-transcript-page').length;

describe('the API transcript lives outside the record (#397)', { timeout: 60_000 }, () => {
    it('a transcript past the old 1 MB budget is saved whole and loaded back without trim markers, while the record stays bounded and lists the pages', async () => {
        await session().open(spec);
        const store = stores[0]!;
        const id = (await session().get()).ref!.id;
        // Four turns with 400 KB outputs: 1.6 MB — past `TRANSCRIPT_BYTES`, past what one page holds.
        const t = transcriptOf(id, 4, 400 * 1024);
        expect(jsonBytes(t)).toBeGreaterThan(TRANSCRIPT_BYTES);
        await store.save(id, t);

        const loaded = await store.load(id);
        expect(loaded).toEqual(t);
        expect(JSON.stringify(loaded)).not.toContain('trimmed');
        expect(await store.load('someone_else')).toBeUndefined();

        const { state, bytes } = await storedState();
        expect(bytes).toBeLessThan(2 * 1024 * 1024 - 256 * 1024);
        // The record's own snapshot is the bounded view: older outputs trimmed there, and there alone.
        expect(jsonBytes(state.transcript)).toBeLessThanOrEqual(TRANSCRIPT_BYTES);
        expect(JSON.stringify(state.transcript)).toContain('trimmed');
        // Every message, in order, over pages of about `TRANSCRIPT_PAGE_BYTES`: a 400 KB output and the small message after it per page.
        const pages = state.transcriptPages!;
        expect(pages.map((p) => p.page)).toEqual([0, 1, 2, 3]);
        expect(pages.map((p) => [p.first, p.last])).toEqual([
            ['u1', 'u2'],
            ['a2', 'u3'],
            ['a3', 'u4'],
            ['a4', 'a4']
        ]);
        expect(pages.reduce((n, p) => n + p.count, 0)).toBe(t.messages.length);
        for (const p of pages) {
            const page = await app.storage.load('session-transcript-page', transcriptPageKey(KEY, p.page));
            expect(jsonBytes(page!.state)).toBeLessThan(TRANSCRIPT_PAGE_BYTES + 64 * 1024);
            expect(jsonBytes(page!.state)).toBeGreaterThanOrEqual(p.bytes);
        }
        // `transcript()` is the view; the store is the history.
        expect(JSON.stringify(await session().transcript())).toContain('trimmed');
    });

    it('a later save rewrites only the pages that changed, and delete removes every page record', async () => {
        await session().open(spec);
        const store = stores[0]!;
        const id = (await session().get()).ref!.id;
        await store.save(id, transcriptOf(id, 4, 400 * 1024));
        const written = pageSaves();
        expect(written).toBe(4);
        // One more turn: the last page grows by the small user message and one page is added — the three before are untouched.
        const more = transcriptOf(id, 5, 400 * 1024);
        await store.save(id, more);
        expect(pageSaves()).toBe(written + 2);
        expect(app.saves.filter((s) => s.type === 'session-transcript-page').slice(written).map((s) => s.key)).toEqual([transcriptPageKey(KEY, 3), transcriptPageKey(KEY, 4)]);
        expect(await store.load(id)).toEqual(more);
        // The same transcript again writes nothing.
        await store.save(id, more);
        expect(pageSaves()).toBe(written + 2);

        await store.delete!(id);
        const { state } = await storedState();
        expect(state.transcript).toBeUndefined();
        expect(state.transcriptPages).toBeUndefined();
        for (let n = 0; n < 5; n++) expect(await app.storage.load('session-transcript-page', transcriptPageKey(KEY, n))).toBeNull();
        expect(await store.load(id)).toBeUndefined();
    });

    it('a transcript that fits the record is held there whole, with no page written — and pages go when it fits again', async () => {
        await session().open(spec);
        const store = stores[0]!;
        const id = (await session().get()).ref!.id;
        const small = transcriptOf(id, 2, 1024);
        await store.save(id, small);
        expect(pageSaves()).toBe(0);
        expect((await storedState()).state.transcriptPages).toBeUndefined();
        expect(await store.load(id)).toEqual(small);
        await store.save(id, transcriptOf(id, 4, 400 * 1024));
        expect(pageSaves()).toBe(4);
        await store.save(id, small);
        const { state } = await storedState();
        expect(state.transcriptPages).toBeUndefined();
        expect(state.transcript).toEqual(small);
        for (let n = 0; n < 4; n++) expect(await app.storage.load('session-transcript-page', transcriptPageKey(KEY, n))).toBeNull();
    });

    it('pageMessages cuts at about the budget, a message alone past it being a page of its own, and fingerprints each page', () => {
        const t = transcriptOf('s', 3, 10);
        const small = pageMessages(t.messages, 1024 * 1024);
        expect(small).toHaveLength(1);
        expect(small[0]!.meta).toEqual({ page: 0, count: 6, bytes: t.messages.reduce((n, m) => n + jsonBytes(m), 0), first: 'u1', last: 'a3' });
        const tight = pageMessages(t.messages, 1);
        expect(tight.map((p) => p.meta.count)).toEqual([1, 1, 1, 1, 1, 1]);
        expect(tight.map((p) => p.messages[0]!.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3']);
        expect(pageMessages([])).toEqual([]);
    });
});
