/**
 * AC-12 — A delegated action requires approval. Delegation preserves that
 * requirement and exposes the approval request to the user.
 *
 * The app's registry on the in-process host (`host.ts`): the assistant
 * delegates to an agent whose policy asks before `memory_search`; the
 * child's session raises the request under its own policy, the child task
 * waits `{approval}`, the parent waits `{child}`, and the request reaches
 * the user's Inbox with a session ref — the user answers it from there
 * (`Session.respond`), the child runs on and the parent gets the result.
 * The second case: a parent's `deny` rule travels down as a constraint the
 * child cannot widen. Deeper: `packages/platform/__tests__/routing/delegation.test.ts`
 * and `packages/platform/__tests__/policy/compile.test.ts`.
 */
import { childTaskId, type TaskId } from '@agentic/core';
import { inboxKey } from '@agentic/platform';
import { edges, startHost, until, type AcceptanceHost } from './host';

let h: AcceptanceHost;
beforeEach(async () => {
    h = await startHost();
});
afterEach(async () => {
    await h.stop();
});

describe('AC-12: a delegated action that requires approval', () => {
    it('the child asks, both tasks wait, the request is in the inbox, and the user’s decision resolves it in the child', async () => {
        const me = h.user('ac12_user');
        const ada = await me.agent('Ada', { tools: [{ name: 'delegate' }] });
        const bob = await me.agent('Bob', { tools: [{ name: 'memory_search' }], approvalPolicy: [{ id: 'ask-memory', match: { tools: ['memory_search'] }, outcome: 'ask' }] });
        await me.createTask('t_parent', ada, { objective: `delegate ${bob}: search: the deploy schedule` });
        await me.routing().run('t_parent' as TaskId);
        const childId = childTaskId('t_parent' as TaskId, 'd1');

        await until(async () => (await me.task(childId).get().catch(() => null))?.status === 'waiting', 'the child to wait for approval');
        const child = await me.task(childId).get();
        expect(child.wait).toEqual({ kind: 'approval', requestId: expect.any(String), sessionId: child.sessionId });
        const parent = await me.task('t_parent').get();
        expect(parent.status).toBe('waiting');
        expect(parent.wait).toEqual({ kind: 'child', childTaskIds: [childId] });
        const { requestId } = child.wait as { requestId: string };

        // Exposed to the user: the child session awaits it, the request view names the rule, and the inbox links to it.
        expect((await me.session(child.sessionId!).get()).openRequests).toEqual([requestId]);
        expect(await me.session(child.sessionId!).request(requestId)).toMatchObject({ request: { requestId, toolName: 'memory_search' }, sessionId: child.sessionId, agentId: bob, taskId: childId, rule: expect.stringContaining('ask') });
        const inbox = h.as(me.principal).actor(h.defs.Inbox, inboxKey(me.ws));
        const rows = await inbox.list();
        expect(rows).toMatchObject([{ kind: 'approval', title: `${bob} asks for approval: memory_search`, ref: { kind: 'session', sessionId: child.sessionId, requestId }, read: false }]);
        expect(await inbox.unread()).toBe(1);

        // The decision goes to the CHILD session — from the inbox card, the chat, or the session page alike.
        const reply = await me.session(child.sessionId!).respond(requestId, { type: 'permission', outcome: 'allow', scope: 'once' });
        expect(reply.kind).toBe('ack');
        const done = await me.settled('t_parent');
        expect(done.status).toBe('completed');
        expect(done.result?.text).toBe('parent done');
        const settledChild = await me.task(childId).get();
        expect(settledChild.status).toBe('completed');
        expect(settledChild.result?.text).toBe('searched: the deploy schedule');
        expect(edges(settledChild)).toEqual(['queued>active', 'active>waiting', 'waiting>active', 'active>completed']);
        expect(settledChild.transitions[2]!.why).toBe(`request ${requestId}: allow`);
        expect((await me.session(child.sessionId!).events()).find((e) => e.type === 'request-resolved')).toMatchObject({ requestId, outcome: 'allow', by: 'client' });
        expect(edges(done)).toEqual(['queued>active', 'active>waiting', 'waiting>active', 'active>completed']);
        // The answered request is acknowledged in the inbox.
        await until(async () => (await inbox.unread()) === 0, 'the inbox to clear');
    });

    it('a child session is never wider than its parent: a parent deny rule constrains the child even where the child allows', async () => {
        const me = h.user('ac12_constrained');
        const ada = await me.agent('Ada', { tools: [{ name: 'delegate' }], approvalPolicy: [{ id: 'no-memory-below-me', match: { tools: ['memory_search'] }, outcome: 'deny' }] });
        const bob = await me.agent('Bob', { tools: [{ name: 'memory_search' }], approvalPolicy: [{ id: 'bob-allows', match: { tools: ['memory_search'] }, outcome: 'allow' }] });
        await me.createTask('t_parent', ada, { objective: `delegate ${bob}: search: anything` });
        await me.routing().run('t_parent' as TaskId);
        await me.settled('t_parent');
        const childId = childTaskId('t_parent' as TaskId, 'd1');
        const child = await me.task(childId).get();
        expect(child.status).toBe('completed');
        expect((await me.session(child.sessionId!).get()).spec?.approvalConstraints).toEqual([{ id: 'no-memory-below-me', match: { tools: ['memory_search'] }, outcome: 'deny' }]);
        const events = await me.session(child.sessionId!).events();
        expect(events.find((e) => e.type === 'request-resolved')).toMatchObject({ outcome: 'deny', by: 'policy', ruleId: 'no-memory-below-me' });
        expect(events.filter((e) => e.type === 'tool-update' && e.callId === 'm1').map((e) => (e as { status: string }).status)).toContain('denied');
        // The child never waited for anyone: the policy answered, and nothing reached the inbox.
        expect(edges(child)).toEqual(['queued>active', 'active>completed']);
        expect(await h.as(me.principal).actor(h.defs.Inbox, inboxKey(me.ws)).list()).toEqual([]);
    });
});
