/**
 * Chats title themselves (#460): the first user line at once, the platform's model title after the first
 * reply (and once more at the eighth), the runtime's own title over both — and a person's rename over all.
 */
import { mockModel } from '@sigx/ai/testing';
import { defineActor } from '@sigx/actors';
import type { Author, AutoTitle, ChatEntry, SessionId, WorkspaceId } from '@agentic/core';
import { ChatPage, TITLE_AT_AGENT_MESSAGES, acceptsAutoTitle, agentMessageCount, createChatTitler, defineChatActor, heuristicTitle, sessionEvents, titleInputOf, type ChatTitler } from '../../src/chat/index.js';
import { REGISTRY_TYPE } from '../../src/registry/key.js';
import { initialChatState, applyChatEntry } from '../../src/chat/state.js';
import { testActorApp, type TestActorApp } from '../../src/testing/index.js';
import { A, B, WS, agent, chatKey, user } from './helpers.js';

const S1 = 'session_1' as SessionId;
const S2 = 'session_2' as SessionId;
const at = 1_700_000_000_000;

describe('heuristicTitle', () => {
    it('is the first non-empty line, whitespace collapsed, at most 60 characters', () => {
        expect(heuristicTitle([{ type: 'text', text: '\n\n  the chats   list is hard to scan \nsecond line' }])).toBe('the chats list is hard to scan');
        expect(heuristicTitle([{ type: 'image', mediaType: 'image/png' }, { type: 'text', text: 'see this' }])).toBe('see this');
        const long = heuristicTitle([{ type: 'text', text: 'word '.repeat(30) }])!;
        expect(long.length).toBeLessThanOrEqual(60);
        expect(long.endsWith('…')).toBe(true);
        expect(heuristicTitle([{ type: 'text', text: '   ' }])).toBeUndefined();
        expect(heuristicTitle([{ type: 'image', mediaType: 'image/png' }])).toBeUndefined();
    });
});

describe('acceptsAutoTitle', () => {
    const state = (title?: string, titleAuto?: AutoTitle) => ({ ...(title === undefined ? {} : { title }), ...(titleAuto ? { titleAuto } : {}) });
    it('anything names an untitled chat; nothing replaces a title a person set', () => {
        for (const source of ['heuristic', 'model', 'runtime'] as const) {
            expect(acceptsAutoTitle(state(), source, S1)).toBe(true);
            expect(acceptsAutoTitle(state('Mine'), source, S1)).toBe(false);
        }
    });
    it('a better source replaces a lesser one, never the other way; a runtime title only yields to the same session', () => {
        expect(acceptsAutoTitle(state('h', { source: 'heuristic' }), 'heuristic')).toBe(true);
        expect(acceptsAutoTitle(state('h', { source: 'heuristic' }), 'model')).toBe(true);
        expect(acceptsAutoTitle(state('h', { source: 'heuristic' }), 'runtime', S1)).toBe(true);
        expect(acceptsAutoTitle(state('m', { source: 'model' }), 'heuristic')).toBe(false);
        expect(acceptsAutoTitle(state('m', { source: 'model' }), 'model')).toBe(true);
        expect(acceptsAutoTitle(state('m', { source: 'model' }), 'runtime', S1)).toBe(true);
        expect(acceptsAutoTitle(state('r', { source: 'runtime', sessionId: S1 }), 'heuristic')).toBe(false);
        expect(acceptsAutoTitle(state('r', { source: 'runtime', sessionId: S1 }), 'model')).toBe(false);
        expect(acceptsAutoTitle(state('r', { source: 'runtime', sessionId: S1 }), 'runtime', S1)).toBe(true);
        expect(acceptsAutoTitle(state('r', { source: 'runtime', sessionId: S1 }), 'runtime', S2)).toBe(false);
        expect(acceptsAutoTitle(state('r', { source: 'runtime', sessionId: S1 }), 'runtime')).toBe(false);
    });
});

describe('titleInputOf / agentMessageCount', () => {
    it('reads the first spoken messages in order, names agents, and leaves notes and empty messages out', () => {
        const state = initialChatState();
        const msg = (author: Author, text: string, extra: object = {}): ChatEntry => ({ t: 'msg', id: `m${state.seq}` as never, author, parts: [{ type: 'text', text }], at, mentions: [], ...extra });
        applyChatEntry(state, msg({ kind: 'user' }, 'Project → app', { project: { id: 'project_1' } }));
        applyChatEntry(state, msg({ kind: 'user' }, 'first question'));
        applyChatEntry(state, { t: 'member', op: 'add', agentId: A, historyAccess: 'all', at });
        applyChatEntry(state, msg({ kind: 'agent', agentId: A, sessionId: S1 }, 'an answer'));
        applyChatEntry(state, msg({ kind: 'agent', agentId: B }, '   '));
        applyChatEntry(state, msg({ kind: 'user' }, 'Working folder for Atlas → C:/x', { workdir: { agentId: A, ref: { environmentId: 'e', path: 'C:/x' } } }));
        expect(agentMessageCount(state)).toBe(2);
        expect(titleInputOf(state, (id) => (id === A ? 'Atlas' : undefined))).toEqual({
            messages: [
                { role: 'user', text: 'first question' },
                { role: 'agent', name: 'Atlas', text: 'an answer' }
            ]
        });
    });
});

describe('Chat auto title (#460)', () => {
    let app: TestActorApp;
    let asked: { workspaceId: WorkspaceId; messages: number }[];
    let answer: () => Promise<string | undefined>;
    const titles: ChatTitler = async (workspaceId, input) => {
        asked.push({ workspaceId, messages: input.messages.length });
        return answer();
    };

    beforeEach(async () => {
        asked = [];
        answer = async () => 'Model title';
        app = testActorApp([defineChatActor({ titles }), ChatPage]);
        await app.start();
    });
    afterEach(async () => {
        await app.stop();
    });

    const chat = (id = 'c1') => app.as(user).actor(defineChatActor(), chatKey(id));
    const startSession = (agentId = A, sessionId = S1) => app.host.publish(sessionEvents(chatKey()), { kind: 'status', agentId, sessionId, status: 'session-started', at });
    const reply = (text: string, agentId = A, sessionId = S1) => app.host.publish(sessionEvents(chatKey()), { kind: 'message', agentId, sessionId, parts: [{ type: 'text', text }], at });
    const runtimeTitle = (title: string, agentId = A, sessionId = S1) => app.host.publish(sessionEvents(chatKey()), { kind: 'title', agentId, sessionId, title, at });
    const titled = async (expected: string) => {
        await vi.waitFor(async () => expect((await chat().get()).title).toBe(expected), { timeout: 2_000 });
        return chat().get();
    };

    it('names an untitled chat by the first user line at once, and not again', async () => {
        const c = chat();
        await c.addAgent(A, 'all');
        await c.post('  Why is the chat list\nso hard to scan?  ');
        let summary = await c.get();
        expect(summary.title).toBe('Why is the chat list');
        expect(summary.titleAuto).toEqual({ source: 'heuristic' });
        const { entries } = await c.history();
        expect(entries.map((e) => e.entry.t)).toEqual(['member', 'msg', 'rename']);
        expect(entries[2]!.entry).toMatchObject({ t: 'rename', title: 'Why is the chat list', auto: { source: 'heuristic' } });
        await c.post('a second message');
        summary = await c.get();
        expect(summary.title).toBe('Why is the chat list');
        expect(asked).toEqual([]);
    });

    it('does not title heuristically on a note, an image-only post or an agent post, and never a chat a person named', async () => {
        const c = chat();
        await c.addAgent(A, 'all');
        await c.setProject(null);
        await c.post([{ type: 'image', mediaType: 'image/png', data: 'AAAA' }]);
        expect((await c.get()).title).toBeUndefined();
        // An agent's post is no heuristic title — it is a reply, so the titler is asked instead.
        await app.as(agent(A)).actor(defineChatActor(), chatKey()).post('an agent speaks first');
        expect((await c.get()).title).not.toBe('an agent speaks first');
        await titled('Model title');
        await c.rename('Named by me');
        await c.post('the first user line');
        expect((await c.get()).title).toBe('Named by me');
        expect((await c.get()).titleAuto).toBeUndefined();
    });

    it('a person keeping a generated title as it is makes it theirs', async () => {
        const c = chat();
        await c.post('keep this');
        expect((await c.get()).titleAuto).toEqual({ source: 'heuristic' });
        await c.rename('keep this');
        expect((await c.get()).titleAuto).toBeUndefined();
        expect((await c.history()).entries.filter((e) => e.entry.t === 'rename')).toHaveLength(2);
        await c.rename('keep this');
        expect((await c.history()).entries.filter((e) => e.entry.t === 'rename')).toHaveLength(2);
    });

    it('asks the titler after the first reply and takes its answer over the heuristic; a person’s rename ends it', async () => {
        const c = chat();
        await c.addAgent(A, 'all');
        await startSession();
        await c.post('first question');
        await reply('an answer');
        const summary = await titled('Model title');
        expect(summary.titleAuto).toEqual({ source: 'model' });
        expect(asked).toEqual([{ workspaceId: WS, messages: 2 }]);
        // A second reply is not a titling point; the eighth is — unless a person has named the chat by then.
        await reply('more');
        expect(asked).toHaveLength(1);
        await c.rename('Mine');
        for (let i = 3; i <= TITLE_AT_AGENT_MESSAGES[1]!; i++) await reply(`reply ${i}`);
        await new Promise((r) => setTimeout(r, 20));
        expect(asked).toHaveLength(1);
        expect((await c.get()).title).toBe('Mine');
    });

    it('titles again at the eighth reply while the title is still generated', async () => {
        const c = chat();
        await c.addAgent(A, 'all');
        await startSession();
        await c.post('first question');
        await reply('an answer');
        await titled('Model title');
        answer = async () => 'Refreshed title';
        for (let i = 2; i <= TITLE_AT_AGENT_MESSAGES[1]!; i++) await reply(`reply ${i}`);
        await titled('Refreshed title');
        expect(asked).toHaveLength(2);
    });

    it('leaves the heuristic title when the titler has nothing (no key) or fails, without a word in the thread', async () => {
        const c = chat();
        await c.addAgent(A, 'all');
        await startSession();
        answer = async () => undefined;
        await c.post('first question');
        await reply('an answer');
        await new Promise((r) => setTimeout(r, 20));
        expect(asked).toHaveLength(1);
        expect((await c.get()).title).toBe('first question');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            answer = async () => Promise.reject(new Error('overloaded'));
            for (let i = 2; i <= TITLE_AT_AGENT_MESSAGES[1]!; i++) await reply(`reply ${i}`);
            await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringMatching(/titling .* failed/), 'overloaded'));
        } finally {
            warn.mockRestore();
        }
        expect((await c.get()).title).toBe('first question');
        expect((await c.history()).entries.filter((e) => e.entry.t === 'rename')).toHaveLength(1);
    });

    it('takes the runtime’s title over a generated one, follows the same session, and ignores another member’s session', async () => {
        const c = chat();
        await c.addAgent(A, 'all');
        await c.addAgent(B, 'all');
        await startSession(A, S1);
        await startSession(B, S2);
        await c.post('first question');
        await reply('an answer');
        await titled('Model title');
        await runtimeTitle('  Chat list  titles ');
        expect(await c.get()).toMatchObject({ title: 'Chat list titles', titleAuto: { source: 'runtime', sessionId: S1 } });
        // The other member's runtime does not rename what the first named; the first's next title does.
        await runtimeTitle('Something else', B, S2);
        expect((await c.get()).title).toBe('Chat list titles');
        await runtimeTitle('Chat list titles, refined');
        expect((await c.get()).title).toBe('Chat list titles, refined');
        // A session the chat does not bind is not heard; a model title no longer replaces a runtime one.
        await runtimeTitle('From a stale session', A, 'session_old' as SessionId);
        expect((await c.get()).title).toBe('Chat list titles, refined');
        for (let i = 2; i <= TITLE_AT_AGENT_MESSAGES[1]!; i++) await reply(`reply ${i}`);
        await new Promise((r) => setTimeout(r, 20));
        expect(asked).toHaveLength(1);
        expect((await c.get()).title).toBe('Chat list titles, refined');
        // And the person's word is final.
        await c.rename('Final');
        await runtimeTitle('Not any more');
        expect((await c.get()).title).toBe('Final');
    });

    it('refuses a title event without a title as a delivery failure', async () => {
        const report = await app.host.publish(sessionEvents(chatKey()), { kind: 'title', agentId: A, sessionId: S1, title: '  ', at } as never);
        expect(report.failures[0]!.message).toMatch(/malformed session event .*title/);
    });

    it('survives a restart with its provenance', async () => {
        const c = chat();
        await c.addAgent(A, 'all');
        await c.post('first question');
        const before = await c.get();
        const { storage } = app;
        await app.stop();
        app = testActorApp([defineChatActor({ titles }), ChatPage], { storage });
        await app.start();
        expect(await chat().get()).toEqual(before);
        expect(before.titleAuto).toEqual({ source: 'heuristic' });
    });
});

describe('createChatTitler', () => {
    const noSecret = defineActor({
        type: REGISTRY_TYPE,
        state: () => ({}),
        methods: () => ({
            async openSecret(name: string): Promise<string> {
                throw new Error(`[registry] no secret "${name}"`);
            }
        })
    });

    it('titles on the given model without touching the Registry', async () => {
        const model = mockModel({ script: [{ text: 'Chat titles' }] });
        const titler = createChatTitler({ registry: () => noSecret, model });
        expect(await titler(WS, { messages: [{ role: 'user', text: 'name this' }] })).toBe('Chat titles');
        expect(model.requests).toHaveLength(1);
    });

    it('is undefined when the workspace has no key — the heuristic stays', async () => {
        const app = testActorApp([noSecret]);
        await app.start();
        try {
            const titler = createChatTitler({ registry: () => noSecret });
            expect(await titler(WS, { messages: [{ role: 'user', text: 'name this' }] })).toBeUndefined();
        } finally {
            await app.stop();
        }
    });
});
