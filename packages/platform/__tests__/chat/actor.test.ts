/**
 * The Chat actor's contract (issue #16): activation (CHT-06), history access
 * per member (CHT-04, MEM-11), bounded writes, the session-events fold
 * (CHT-11) and the authorization chain (architecture §9).
 */
import type { AgentId, ChatEntry, EnvironmentId, MachineId, Principal, Scope, SessionId, WorkspaceId } from '@agentic/core';
import { Chat, ChatPage, MAX_TITLE_LENGTH, PAGE, WINDOW, pageKey, sessionEvents } from '../../src/chat/index.js';
import { statusOf, type TestActorApp } from '../../src/testing/index.js';
import { A, B, C, WS, agent, chatKey, countingStorage, startChatApp, user } from './helpers.js';

let app: TestActorApp;

beforeEach(async () => {
    app = await startChatApp();
});

afterEach(async () => {
    await app.stop();
});

/** The chat `c1` as seen by `principal`. */
const chatAs = (principal: Principal | null, id = 'c1') => app.as(principal).actor(Chat, chatKey(id));

const text = (entry: ChatEntry): string | undefined =>
    entry.t === 'msg' ? entry.parts.map((p) => (p.type === 'text' ? p.text : '')).join('') : undefined;

describe('activation (CHT-06)', () => {
    it('a group address activates every agent member', async () => {
        const chat = chatAs(user);
        await chat.addAgent(A, 'all');
        await chat.addAgent(B, 'all');
        const result = await chat.post('hello everyone', 'all');
        expect(result.activated).toEqual([A, B]);
        expect(result.messageId).toMatch(/^msg_/);
    });

    it('a direct mention activates only that agent', async () => {
        const chat = chatAs(user);
        await chat.addAgent(A);
        await chat.addAgent(B);
        expect((await chat.post('hey', [B])).activated).toEqual([B]);
        // A mention of a non-member is stored, never activated.
        expect((await chat.post('hey', [C])).activated).toEqual([]);
    });

    it('a single-agent chat activates its agent without a mention; two agents and no mention store only', async () => {
        const chat = chatAs(user);
        await chat.addAgent(A);
        expect((await chat.post('no mention')).activated).toEqual([A]);
        await chat.addAgent(B);
        expect((await chat.post('no mention')).activated).toEqual([]);
    });

    it('the coordinator takes an unaddressed message (CHT-07) and is cleared when removed', async () => {
        const chat = chatAs(user);
        await chat.addAgent(A);
        await chat.addAgent(B);
        await chat.setCoordinator(B);
        expect((await chat.post('unaddressed')).activated).toEqual([B]);
        expect((await chat.get()).coordinator).toBe(B);
        await expect(chat.setCoordinator(C)).rejects.toThrow(/not a member/);
        expect(await chat.removeAgent(B)).toBe(true);
        expect(await chat.removeAgent(B)).toBe(false);
        expect((await chat.get()).coordinator).toBeNull();
        expect((await chat.post('unaddressed')).activated).toEqual([A]);
    });

    it("an agent's own post is attributed to it and never activates itself", async () => {
        await chatAs(user).addAgent(A, 'all');
        const result = await chatAs(agent(A)).post('from A', 'all');
        expect(result.activated).toEqual([]);
        const { entries } = await chatAs(agent(A)).history();
        const last = entries.at(-1)!.entry;
        expect(last.t).toBe('msg');
        if (last.t === 'msg') {
            expect(last.author).toEqual({ kind: 'agent', agentId: A, sessionId: `session_${A}` });
            expect(last.sessionId).toBe(`session_${A}`);
        }
    });
});

describe('history access (CHT-04, MEM-11)', () => {
    it('a from-now member cannot read entries before its join; an all member reads everything', async () => {
        const chat = chatAs(user);
        await chat.post('m1');
        await chat.post('m2');
        const member = await chat.addAgent(B, 'from-now');
        expect(member.historyFrom).toBe(2);
        await chat.post('m3');
        await chat.addAgent(A, 'all');

        const asB = await chatAs(agent(B)).history();
        expect(asB.next).toBeNull();
        expect(asB.entries.map((e) => e.seq)).toEqual([2, 3, 4]);
        expect(asB.entries.map((e) => text(e.entry))).toEqual([undefined, 'm3', undefined]);
        expect(await chatAs(agent(B)).search('m1')).toEqual([]);
        expect((await chatAs(agent(B)).search('m3')).map((h) => h.seq)).toEqual([3]);

        const asA = await chatAs(agent(A)).history();
        expect(asA.entries.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
        expect((await chatAs(agent(A)).search('M')).map((h) => h.seq)).toEqual([3, 1, 0]);

        expect((await chat.history()).entries).toHaveLength(5);
    });

    it('an agent that is not a member sees nothing, and a removed member loses its view', async () => {
        const chat = chatAs(user);
        await chat.post('m1');
        await chat.addAgent(A, 'all');
        expect(await chatAs(agent(C)).history()).toEqual({ entries: [], next: null });
        expect(await chatAs(agent(C)).search('m1')).toEqual([]);
        await chat.removeAgent(A);
        expect((await chatAs(agent(A)).history()).entries).toEqual([]);
    });

    it('pages backwards with an exclusive cursor and clamps the limit', async () => {
        const chat = chatAs(user);
        for (let i = 0; i < 7; i++) await chat.post(`m${i}`);
        const first = await chat.history(null, 3);
        expect(first.entries.map((e) => e.seq)).toEqual([4, 5, 6]);
        expect(first.next).toBe(4);
        const second = await chat.history(first.next, 3);
        expect(second.entries.map((e) => e.seq)).toEqual([1, 2, 3]);
        const third = await chat.history(second.next, 3);
        expect(third.entries.map((e) => e.seq)).toEqual([0]);
        expect(third.next).toBeNull();
        expect((await chat.history(null, 0)).entries).toHaveLength(7);
        expect((await chat.history(99, 2)).entries.map((e) => e.seq)).toEqual([5, 6]);
    });
});

describe('persistence', () => {
    // 500 turns; coverage instrumentation makes this several times slower.
    it('500 posts append without a full-state rewrite: every save is bounded by the window', { timeout: 30_000 }, async () => {
        await app.stop();
        const { storage, writes } = countingStorage();
        app = await startChatApp(storage);
        const chat = chatAs(user);
        await chat.addAgent(A, 'all');
        const posts = 500;
        for (let i = 0; i < posts; i++) await chat.post(`post ${i}`);

        const chatWrites = writes.filter((w) => w.type === 'Chat');
        const pageWrites = writes.filter((w) => w.type === 'ChatPage');
        // One write per entry, plus one compaction per archived page — never a rewrite of the whole history.
        const archived = Math.floor((posts + 1 - WINDOW) / PAGE);
        expect(archived).toBeGreaterThan(0);
        expect(chatWrites).toHaveLength(posts + 1 + archived);
        expect(pageWrites).toHaveLength(archived);
        expect(Math.max(...chatWrites.map((w) => w.entries))).toBeLessThanOrEqual(WINDOW + PAGE);
        expect(chatWrites.at(-1)!.entries).toBeLessThan(posts);

        // The archived entries are still the chat's history, in order.
        const summary = await chat.get();
        expect(summary.seq).toBe(posts + 1);
        const seen: number[] = [];
        let cursor: number | null = null;
        do {
            const page = await chat.history(cursor, 200);
            seen.unshift(...page.entries.map((e) => e.seq));
            cursor = page.next;
        } while (cursor !== null);
        expect(seen).toEqual(Array.from({ length: posts + 1 }, (_, i) => i));
        // seq 0 is the join entry; the first post is seq 1, read back from page 0.
        const oldest = await chat.history(2, 1);
        expect(oldest.entries.map((e) => e.seq)).toEqual([1]);
        expect(text(oldest.entries[0]!.entry)).toBe('post 0');
        expect((await chat.search('post 7', 3)).map((h) => text(h.entry))).toEqual(['post 79', 'post 78', 'post 77']);
    });

    it('rebuilds the same state after a restart', async () => {
        const chat = chatAs(user);
        await chat.addAgent(A, 'from-now');
        await chat.post('m1', [A]);
        await chat.setCoordinator(A);
        const before = await chat.get();
        const { storage } = app;
        await app.stop();

        app = await startChatApp(storage);
        const after = await chatAs(user).get();
        expect(after).toEqual(before);
        expect((await chatAs(user).history()).entries).toHaveLength(3);
    });
});

describe('session events (CHT-11)', () => {
    it('folds status and final messages into entries and tracks active sessions; typing is not durable', async () => {
        const chat = chatAs(user);
        await chat.addAgent(A);
        const sessionId = 'session_1' as SessionId;
        const at = 1_700_000_000_000;

        let report = await app.host.publish(sessionEvents(chatKey()), { kind: 'status', agentId: A, sessionId, status: 'session-started', at });
        expect(report).toMatchObject({ delivered: 1, failures: [] });
        expect((await chat.get()).activeSessions).toEqual({ [A]: sessionId });

        await app.host.publish(sessionEvents(chatKey()), { kind: 'status', agentId: A, sessionId, status: 'typing', at });
        await app.host.publish(sessionEvents(chatKey()), {
            kind: 'message',
            agentId: A,
            sessionId,
            parts: [{ type: 'text', text: 'final answer' }],
            mentions: [B],
            at
        });
        report = await app.host.publish(sessionEvents(chatKey()), { kind: 'status', agentId: A, sessionId, status: 'session-ended', at });
        expect(report.delivered).toBe(1);
        expect((await chat.get()).activeSessions).toEqual({});

        const { entries } = await chat.history();
        expect(entries.map((e) => e.entry.t)).toEqual(['member', 'status', 'msg', 'status']);
        expect(entries[1]!.entry).toEqual({ t: 'status', agentId: A, kind: 'session-started', ref: sessionId, at });
        expect(entries[2]!.entry).toMatchObject({
            t: 'msg',
            author: { kind: 'agent', agentId: A, sessionId },
            parts: [{ type: 'text', text: 'final answer' }],
            mentions: [B],
            sessionId
        });
        // Another chat's key never receives it.
        const other = await app.host.publish(sessionEvents(chatKey('c2')), { kind: 'status', agentId: A, sessionId, status: 'session-ended', at });
        expect(other.delivered).toBe(1);
        expect((await chat.history()).entries).toHaveLength(4);
    });

    it('reports a malformed payload as a delivery failure, not a crash', async () => {
        const report = await app.host.publish(sessionEvents(chatKey()), null as never);
        expect(report.failures).toHaveLength(1);
        expect(report.failures[0]!.message).toMatch(/malformed session event/);
    });

    it.each([
        ['a status with no ids', { kind: 'status' }],
        ['an unknown status', { kind: 'status', agentId: A, sessionId: 's1', status: 'dancing', at: 1 }],
        ['a status without at', { kind: 'status', agentId: A, sessionId: 's1', status: 'session-started' }],
        ['a message without parts', { kind: 'message', agentId: A, sessionId: 's1', at: 1 }],
        ['a message with a non-array mentions', { kind: 'message', agentId: A, sessionId: 's1', parts: [], mentions: B, at: 1 }],
        ['an unknown kind', { kind: 'delta', agentId: A, sessionId: 's1', at: 1 }]
    ])('refuses %s as a delivery failure and records nothing', async (_name, payload) => {
        const before = (await chatAs(user).history()).entries.length;
        const report = await app.host.publish(sessionEvents(chatKey()), payload as never);
        expect(report.failures).toHaveLength(1);
        expect(report.failures[0]!.message).toMatch(/malformed session event/);
        expect((await chatAs(user).history()).entries).toHaveLength(before);
        expect((await chatAs(user).get()).activeSessions).toEqual({});
    });
});

describe('authorization (§9)', () => {
    it('denies another workspace, anonymous callers and external clients without the chats scope', async () => {
        expect(await statusOf(chatAs({ kind: 'user', userId: 'u2', workspaceId: 'ws_other' as WorkspaceId }).get())).toBe(403);
        expect(await statusOf(chatAs(null).get())).toBe(401);
        const external = (scopes: readonly Scope[]): Principal => ({ kind: 'external', workspaceId: WS, clientId: 'cli', scopes });
        expect(await statusOf(chatAs(external(['tasks'])).get())).toBe(403);
        await expect(chatAs(external(['chats'])).addAgent(A)).resolves.toMatchObject({ historyFrom: 0 });
        expect((await chatAs(external(['chats'])).post('as external', [A])).activated).toEqual([A]);
    });

    it('lets only users and external clients change membership; machines never post', async () => {
        await chatAs(user).addAgent(A, 'all');
        expect(await statusOf(chatAs(agent(A)).addAgent(B))).toBe(403);
        expect(await statusOf(chatAs(agent(A)).setCoordinator(A))).toBe(403);
        await expect(chatAs(agent(A)).post('fine')).resolves.toMatchObject({ activated: [] });
        const machine: Principal = { kind: 'machine', workspaceId: WS, machineId: 'machine_1' as MachineId };
        expect(await statusOf(chatAs(machine).post('nope'))).toBe(403);
        await expect(chatAs(machine).get()).resolves.toMatchObject({ members: { [A]: { historyFrom: 0 } } });
    });

    it('the page actors are not wire-callable', async () => {
        expect(await statusOf(app.as(user).actor(ChatPage, pageKey(chatKey(), 0)).read())).toBe(403);
    });
});

describe('membership bookkeeping', () => {
    it('addAgent is idempotent and the join entry carries the access', async () => {
        const chat = chatAs(user);
        const first = await chat.addAgent(A, 'from-now');
        const again = await chat.addAgent(A, 'all');
        expect(again).toEqual(first);
        const { entries } = await chat.history();
        expect(entries).toHaveLength(1);
        expect(entries[0]!.entry).toMatchObject({ t: 'member', op: 'add', agentId: A, historyAccess: 'from-now' });
        const ids: AgentId[] = Object.keys((await chat.get()).members) as AgentId[];
        expect(ids).toEqual([A]);
    });
});

describe('title (#124)', () => {
    it('is absent until rename sets it; a rename is one entry, idempotent, and survives a restart', async () => {
        const chat = chatAs(user);
        expect((await chat.get()).title).toBeUndefined();
        expect('title' in (await chat.get())).toBe(false);
        await chat.rename('  Release   plan ');
        expect((await chat.get()).title).toBe('Release plan');
        await chat.rename('Release plan');
        const { entries } = await chat.history();
        expect(entries).toHaveLength(1);
        expect(entries[0]!.entry).toMatchObject({ t: 'rename', title: 'Release plan' });
        await chat.rename('Release plan v2');
        const before = await chat.get();
        expect(before.title).toBe('Release plan v2');

        const { storage } = app;
        await app.stop();
        app = await startChatApp(storage);
        expect(await chatAs(user).get()).toEqual(before);
    });

    it('rejects a blank or overlong title without storing anything', async () => {
        const chat = chatAs(user);
        await expect(chat.rename('   ')).rejects.toThrow(/title is required/);
        await expect(chat.rename('x'.repeat(MAX_TITLE_LENGTH + 1))).rejects.toThrow(/longer than/);
        expect((await chat.get()).seq).toBe(0);
        expect((await chat.get()).title).toBeUndefined();
    });

    it('is the user’s (or an external client’s) call, never an agent’s', async () => {
        await chatAs(user).addAgent(A, 'all');
        expect(await statusOf(chatAs(agent(A)).rename('mine'))).toBe(403);
        const external: Principal = { kind: 'external', workspaceId: WS, clientId: 'cli', scopes: ['chats'] };
        await chatAs(external).rename('from the CLI');
        expect((await chatAs(agent(A)).get()).title).toBe('from the CLI');
    });
});

describe('working folder (#190)', () => {
    const E1 = 'env_1' as EnvironmentId;
    const folder = { environmentId: E1, path: 'C:/src/app' };

    it('setWorkdir stores the folder on the member, appends a visible note that activates nobody, and survives a restart', async () => {
        const chat = chatAs(user);
        await chat.addAgent(A);
        const member = await chat.setWorkdir(A, folder);
        expect(member.workdir).toEqual(folder);
        expect((await chat.get()).members[A]!.workdir).toEqual(folder);
        const { entries } = await chat.history();
        const note = entries.at(-1)!.entry;
        expect(note).toMatchObject({ t: 'msg', author: { kind: 'user' }, mentions: [], workdir: { agentId: A, ref: folder } });
        expect(text(note)).toBe(`Working folder for ${A} → C:/src/app on env_1`);
        // Idempotent: the same folder again writes nothing.
        await chat.setWorkdir(A, folder);
        expect((await chat.history()).entries).toHaveLength(entries.length);

        const before = await chat.get();
        const { storage } = app;
        await app.stop();
        app = await startChatApp(storage);
        expect(await chatAs(user).get()).toEqual(before);
    });

    it('null clears it with a note of its own', async () => {
        const chat = chatAs(user);
        await chat.addAgent(A);
        await chat.setWorkdir(A, folder);
        const member = await chat.setWorkdir(A, null);
        expect(member.workdir).toBeUndefined();
        expect('workdir' in (await chat.get()).members[A]!).toBe(false);
        expect(text((await chat.history()).entries.at(-1)!.entry)).toBe(`Working folder for ${A} cleared`);
    });

    it('is for members only (404), refuses a folder without an environment or a path (400), and is the user’s call', async () => {
        const chat = chatAs(user);
        await chat.addAgent(A);
        expect(await statusOf(chat.setWorkdir(B, folder))).toBe(404);
        expect(await statusOf(chat.setWorkdir(A, { environmentId: E1, path: '  ' }))).toBe(400);
        expect(await statusOf(chat.setWorkdir(A, { path: 'C:/src' } as never))).toBe(400);
        expect(await statusOf(chatAs(agent(A)).setWorkdir(A, folder))).toBe(403);
        expect((await chat.get()).members[A]!.workdir).toBeUndefined();
    });
});
