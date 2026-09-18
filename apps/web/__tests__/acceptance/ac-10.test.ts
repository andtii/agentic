/**
 * AC-10 — An agent participates in a shared chat. Other participants cannot
 * access its private memory solely through chat membership.
 *
 * The app's registry on the in-process host (`host.ts`): two agents share
 * one chat; one of them holds a fact in its private scope. The other's
 * identity is refused on that scope by the Memory actor (403), gets
 * nothing from a shared scope without an ACL, and — the path an agent
 * really takes — its session's `memory_search` tool, run on the real local
 * runtime path, searches only its own scope and never finds the fact. The
 * user, who owns every scope, can read it; a shared scope opens per ACL.
 * Deeper: `packages/platform/__tests__/memory.test.ts` (every principal
 * kind against every scope, ACL edits).
 */
import type { AgentId, Principal, SessionId, TaskId } from '@agentic/core';
import { Chat, Memory, memoryActorKey } from '@agentic/platform';
import { isServerFnError } from '@sigx/server';
import { chatKeyOf } from '../../src/actors/keys';
import { startHost, type AcceptanceHost } from './host';

const status = (error: unknown): number | undefined => (isServerFnError(error) ? error.status : undefined);
const refused = (call: Promise<unknown>): Promise<number | undefined> => call.then(() => undefined, (e: unknown) => status(e));

let h: AcceptanceHost;
beforeEach(async () => {
    h = await startHost();
});
afterEach(async () => {
    await h.stop();
});

describe('AC-10: an agent in a shared chat', () => {
    it('another member cannot reach its private memory — not directly, not through its own memory tool, not via a shared scope without an ACL', async () => {
        const me = h.user('ac10_user');
        const ada = await me.agent('Ada', { tools: [{ name: 'memory_search' }] });
        const bob = await me.agent('Bob', { tools: [{ name: 'memory_search' }] });
        const { chatId } = await me.workspace().createChat({});
        const chat = h.as(me.principal).actor(Chat, chatKeyOf(me.userId, chatId));
        await chat.addAgent(ada, 'all');
        await chat.addAgent(bob, 'all');
        expect(Object.keys((await chat.get()).members).sort()).toEqual([ada, bob].sort());

        // Ada keeps a fact in her own scope.
        const asAda: Principal = { kind: 'agent', workspaceId: me.ws, agentId: ada, sessionId: 'session_ada' as SessionId };
        const asBob: Principal = { kind: 'agent', workspaceId: me.ws, agentId: bob, sessionId: 'session_bob' as SessionId };
        const adaScope = memoryActorKey(me.ws, `agent:${ada}`);
        const fact = { kind: 'fact' as const, text: 'the team deploys on fridays', tags: ['deploy'], confidence: 'stated' as const, provenance: { source: 'agent' as const } };
        const put = await h.as(asAda).actor(Memory, adaScope).put(fact);
        expect((await h.as(asAda).actor(Memory, adaScope).query({ text: 'deploys', limit: 5 })).map((r) => r.entry.text)).toEqual([fact.text]);

        // Bob, a member of the same chat, is refused on Ada's scope: no read, no query, no write.
        expect(await refused(h.as(asBob).actor(Memory, adaScope).query({ text: 'deploys', limit: 5 }))).toBe(403);
        expect(await refused(h.as(asBob).actor(Memory, adaScope).get(put.id))).toBe(403);
        expect(await refused(h.as(asBob).actor(Memory, adaScope).put(fact))).toBe(403);
        // A shared scope is closed to every agent until the user opens it with an ACL.
        const shared = memoryActorKey(me.ws, 'shared:team');
        expect(await refused(h.as(asBob).actor(Memory, shared).query({ limit: 5 }))).toBe(403);

        // The path an agent really takes — its own memory tool in a session: Bob searches and finds nothing of Ada's.
        await me.createTask('t_bob', bob, { objective: 'search: deploys' });
        await me.routing().run('t_bob' as TaskId);
        const t = await me.settled('t_bob');
        expect(t.status).toBe('completed');
        expect(t.result?.text).toBe('searched: deploys');
        const transcript = await me.session(t.sessionId!).transcript();
        const call = transcript!.messages.flatMap((m) => m.parts).find((p) => p.type === 'tool' && p.callId === 'm1') as { status: string; output?: unknown } | undefined;
        expect(call?.status).toBe('completed');
        expect(JSON.stringify(call?.output ?? '')).not.toContain('fridays');
        // The search went to Bob's own scope and nowhere else: Ada's fact was never read on his behalf.
        expect((await me.session(t.sessionId!).get()).spec?.retrieval?.scopes).toEqual([`agent:${bob}`]);
        const chatText = JSON.stringify(await chat.history(null, 50));
        expect(chatText).not.toContain('fridays');

        // The user owns every scope, and an ACL opens a shared scope per access — membership alone never does.
        expect((await h.as(me.principal).actor(Memory, adaScope).get(put.id))?.text).toBe(fact.text);
        await h.as(me.principal).actor(Memory, shared).put({ ...fact, text: 'shared: standup at nine' });
        await h.as(me.principal).actor(Memory, shared).setAcl({ read: [bob as AgentId], write: [] });
        expect((await h.as(asBob).actor(Memory, shared).query({ limit: 5 })).map((r) => r.entry.text)).toEqual(['shared: standup at nine']);
        expect(await refused(h.as(asAda).actor(Memory, shared).query({ limit: 5 }))).toBe(403);
        expect(await refused(h.as(asBob).actor(Memory, adaScope).get(put.id))).toBe(403);
    });
});
