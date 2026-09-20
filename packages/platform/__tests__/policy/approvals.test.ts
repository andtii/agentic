/**
 * Approvals end to end (OPS-02, COL-10, CHT-09, #40): the agent's
 * `approvalPolicy` compiled to the session policy, a `request` reaching the
 * Task, the Inbox, the chat and the audit log, a decision from any client
 * through `Session.respond` with `once` | `session` scope, and the grants a
 * session lists — over `mockAgent` through the real Routing + Session +
 * Task + Agent + Chat + Inbox actors with a capturing audit port. Offline
 * and deterministic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actorKey, type AgentId, type ChatId, type MessageId, type TaskContract, type TaskId, type WorkspaceId } from '@agentic/core';
import type { AgentEvent } from '@sigx/ai-agent';
import { mockAgent, type MockAgent, type MockStep } from '@sigx/ai-agent/testing';

import { AgentActor, agentKey, type AgentConfigPatch } from '../../src/agent/index';
import { capturingAuditPort } from '../../src/audit/index';
import { Chat, ChatPage } from '../../src/chat/index';
import { defineInbox, inboxKey } from '../../src/notify/index';
import { describeRule, parseRequestRef, requestRef, ruleFor, sessionGrantsOf, sessionPolicy } from '../../src/policy/index';
import { defineRoutingActor, routingKey } from '../../src/routing/index';
import { defineSessionActor, type SessionFactory } from '../../src/session/index';
import { TaskActor, taskKey, type TaskView } from '../../src/task/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const ADA = 'agent_ada' as AgentId;
const CHAT = 'chat_1' as ChatId;

const until = async (check: () => Promise<boolean> | boolean, what: string, timeoutMs = 4_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
};

/**
 * The scripted runtime: the objective names the steps. `rm` is a destructive
 * tool, `ls` a read-only one; `twice` calls `rm` twice under one permission
 * key, `ask` raises an input request.
 */
function scriptedAgent(): MockAgent {
    const rm = (permissionKey = 'rm:tmp'): MockStep => ({ tool: { name: 'rm', category: 'destructive', input: { path: '/tmp/x' }, output: 'gone', permissionKey, annotations: { destructive: true } } });
    const ls: MockStep = { tool: { name: 'ls', category: 'read', input: { path: '.' }, output: 'a b', annotations: { readOnly: true } } };
    return mockAgent({
        respond: (input) => {
            const text = input.map((p) => (p.type === 'text' ? p.text : '')).join('');
            if (text.startsWith('destroy')) return [rm(), { text: 'removed' }];
            if (text.startsWith('read')) return [ls, { text: 'listed' }];
            if (text.startsWith('both')) return [ls, rm(), { text: 'did both' }];
            if (text.startsWith('twice')) return [rm(), rm(), { text: 'removed twice' }];
            if (text.startsWith('ask')) return [{ request: { kind: 'input', message: 'Which one?' } }, { text: 'thanks' }];
            return [{ text: `echo: ${text}` }];
        }
    });
}

/** The real thing minus the model: every session opens under the policy compiled from its spec. */
function policyFactory(agent: MockAgent): SessionFactory {
    return async (runtime, c) => {
        if (runtime !== 'anthropic-api') return null;
        const session = await agent.session({ policy: sessionPolicy(c.spec), signal: c.signal, ...(c.resume ? { resume: c.resume } : {}) });
        return { session, agentId: agent.id, capabilities: agent.capabilities };
    };
}

let app: TestActorApp;
let Session: ReturnType<typeof defineSessionActor>;
let Routing: ReturnType<typeof defineRoutingActor>;
let Inbox: ReturnType<typeof defineInbox>;
let audit: ReturnType<typeof capturingAuditPort>;

beforeEach(async () => {
    audit = capturingAuditPort();
    Inbox = defineInbox({});
    Session = defineSessionActor({ factory: policyFactory(scriptedAgent()), inbox: () => Inbox, audit });
    Routing = defineRoutingActor({ sessions: () => Session, machines: () => Session, audit });
    app = testActorApp([Routing, Session, TaskActor, AgentActor, Inbox, Chat, ChatPage]);
    await app.start();
});

afterEach(async () => {
    await app.stop();
});

const routing = () => app.as(owner).actor(Routing, routingKey(WS));
const task = (id: string) => app.as(owner).actor(TaskActor, taskKey(WS, id as TaskId));
const session = (id: string) => app.as(owner).actor(Session, actorKey(WS, 'session', id));
const inbox = () => app.as(owner).actor(Inbox, inboxKey(WS));
const chat = () => app.as(owner).actor(Chat, actorKey(WS, 'chat', CHAT));

const ASK_DESTRUCTIVE = { id: 'category:destructive', match: { categories: ['destructive'] as const }, outcome: 'ask' as const };
const ALLOW_READ = { id: 'category:read', match: { categories: ['read'] as const }, outcome: 'allow' as const };

async function agent(patch: AgentConfigPatch = {}): Promise<void> {
    await app.as(owner).actor(AgentActor, agentKey(WS, ADA)).update({ name: 'Ada', instructions: 'Be brief.', tools: [{ name: 'rm' }, { name: 'ls' }], execution: { runtime: 'anthropic-api', offlinePolicy: 'fail' }, approvalPolicy: [ASK_DESTRUCTIVE, ALLOW_READ], ...patch }, 'create');
}

/** A task in the chat, run through the router; resolves once the router has a session for it. */
async function run(id: string, objective: string, extra: Partial<TaskContract> = {}): Promise<TaskView> {
    await task(id).create({ objective, origin: { kind: 'user', chatId: CHAT, messageId: 'msg_1' as MessageId }, assignee: ADA, context: [], constraints: {}, ...extra }, { owner: ADA });
    return routing().run(id as TaskId);
}

const settled = (id: string) => until(async () => ['completed', 'failed', 'cancelled'].includes((await task(id).get()).status), `task ${id} to settle`);
const awaiting = (id: string) => until(async () => (await task(id).get()).status === 'waiting', `task ${id} to wait`);
const events = async (sessionId: string): Promise<AgentEvent[]> => session(sessionId).events();
const ofKind = (kind: string) => audit.events.filter((e) => e.kind === kind);
/** The chat's status entries as `kind:ref` (a session id ref is elided: the request refs are what pair up here). */
const statuses = async () => (await chat().history()).entries.map((e) => e.entry).filter((e) => e.t === 'status').map((e) => `${e.kind}${e.ref && !e.ref.startsWith('session_') ? `:${e.ref}` : ''}`);

describe('policy: ask on destructive prompts, allow on read never does', () => {
    it('a destructive call under an `ask` rule raises one request: the task waits, the inbox and the chat hear it, the audit records it once', async () => {
        await agent();
        const t = await run('t_1', 'destroy it');
        await awaiting('t_1');
        const sid = t.sessionId!;
        const info = await session(sid).get();
        expect(info.status).toBe('awaiting');
        expect(info.openRequests).toHaveLength(1);
        const requestId = info.openRequests[0]!;
        expect((await task('t_1').get()).wait).toEqual({ kind: 'approval', requestId, sessionId: sid });

        // The Inbox: one unread approval, deep-linked to the session and the request.
        expect(await inbox().list()).toMatchObject([{ kind: 'approval', title: `Ada asks for approval: rm`, read: false, ref: { kind: 'session', sessionId: sid, requestId } }]);
        expect(await inbox().unread()).toBe(1);
        // The chat: a `request` status entry with the pairing ref.
        expect(await statuses()).toEqual(['session-started', `request:approval:${requestId}`]);
        // The record a card renders: the request, the call's input, no decision yet.
        const record = (await session(sid).request(requestId))!;
        expect(record).toMatchObject({ sessionId: sid, agentId: ADA, chatId: CHAT, taskId: 't_1', rule: 'ask on destructive', request: { kind: 'permission', toolName: 'rm', permissionKey: 'rm:tmp' }, input: { path: '/tmp/x' }, category: 'destructive' });
        expect(record.resolved).toBeUndefined();
        expect(await session(sid).requests({ openOnly: true })).toHaveLength(1);
        // The rule the card names.
        expect(describeRule(ruleFor([ASK_DESTRUCTIVE, ALLOW_READ], { kind: 'permission', toolName: 'rm', category: 'destructive', source: 'client' })!)).toBe('ask on destructive');
        // The audit: requested once, nothing resolved yet.
        expect(ofKind('approval.requested')).toHaveLength(1);
        expect(ofKind('approval.requested')[0]).toMatchObject({ by: `agent:${ADA}`, sessionId: sid, taskId: 't_1', data: { requestId, toolName: 'rm', permissionKey: 'rm:tmp' } });
        expect(ofKind('approval.resolved')).toHaveLength(0);

        // The decision, from the inbox: allow once.
        const reply = await session(sid).respond(requestId, { type: 'permission', outcome: 'allow', scope: 'once' });
        expect(reply.kind).toBe('ack');
        await settled('t_1');
        expect((await task('t_1').get()).status).toBe('completed');
        expect((await task('t_1').get()).result?.text).toBe('removed');
        // Resolved: the audit once, by the user; the notification read; the chat paired up; the record carries the decision; no grant (scope once).
        expect(ofKind('approval.resolved')).toHaveLength(1);
        expect(ofKind('approval.resolved')[0]).toMatchObject({ by: `user:${WS}`, data: { requestId, outcome: 'allow', resolvedBy: 'client', scope: 'once' } });
        expect((await inbox().list()).map((n) => n.read)).toEqual([true]);
        expect(await inbox().unread()).toBe(0);
        // The chat member's session stays live after its task settles (#393): no `session-ended` in the thread.
        expect(await statuses()).toEqual(['session-started', `request:approval:${requestId}`, `request-resolved:approval:${requestId}`]);
        expect((await session(sid).request(requestId))!.resolved).toMatchObject({ outcome: 'allow', scope: 'once', by: 'client' });
        expect((await session(sid).get()).grants).toEqual([]);
        expect(parseRequestRef(requestRef(record.request))).toEqual({ need: 'approval', requestId });
    });

    it('a read-only call under an `allow` rule ahead of `ask everything` never prompts: no request, no notification, no audit', async () => {
        await agent({ approvalPolicy: [ALLOW_READ, { id: 'ask-everything', match: {}, outcome: 'ask' }] });
        const t = await run('t_2', 'read it');
        await settled('t_2');
        expect((await task('t_2').get())).toMatchObject({ status: 'completed', result: { text: 'listed' } });
        const evs = await events(t.sessionId!);
        expect(evs.filter((e) => e.type === 'request')).toEqual([]);
        expect(evs.filter((e) => e.type === 'request-resolved')).toMatchObject([{ outcome: 'allow', by: 'policy', ruleId: 'category:read' }]);
        expect(await inbox().list()).toEqual([]);
        expect(ofKind('approval.requested')).toEqual([]);
        expect(ofKind('approval.resolved')).toEqual([]);
        expect((await task('t_2').get()).transitions.map((x) => `${x.from}>${x.to}`)).toEqual(['queued>active', 'active>completed']);
    });

    it('first match decides in order: under the same rules a turn that reads then destroys prompts for the destructive call only', async () => {
        await agent({ approvalPolicy: [ALLOW_READ, { id: 'ask-everything', match: {}, outcome: 'ask' }] });
        const t = await run('t_3', 'both');
        await awaiting('t_3');
        const evs = await events(t.sessionId!);
        expect(evs.filter((e) => e.type === 'request').map((e) => (e as { toolName?: string }).toolName)).toEqual(['rm']);
        expect((await inbox().list()).map((n) => n.title)).toEqual([`Ada asks for approval: rm`]);
        await session(t.sessionId!).respond((await session(t.sessionId!).get()).openRequests[0]!, { type: 'permission', outcome: 'deny', scope: 'once', message: 'not today' });
        await settled('t_3');
        expect(ofKind('approval.resolved')[0]).toMatchObject({ data: { outcome: 'deny', resolvedBy: 'client' } });
    });
});

describe('respond from any client, once or for the session', () => {
    it('a decision from a second consumer resolves the request the first one tails; the first one’s late answer is a no-op ack, and nothing resolves twice', async () => {
        await agent();
        const t = await run('t_4', 'destroy it');
        await awaiting('t_4');
        const sid = t.sessionId!;
        const requestId = (await session(sid).get()).openRequests[0]!;

        // Consumer A (the chat) tails the session and waits for the resolution.
        const seen: AgentEvent[] = [];
        const tailed = (async () => {
            for await (const ev of session(sid).tail({ epoch: 0, seq: 0 })) {
                seen.push(ev);
                if (ev.type === 'request-resolved') return ev;
            }
            return undefined;
        })();
        // Consumer B (the inbox page) answers.
        expect((await session(sid).respond(requestId, { type: 'permission', outcome: 'allow', scope: 'once' }, 'respond:from-b')).kind).toBe('ack');
        const resolved = await tailed;
        expect(resolved).toMatchObject({ requestId, outcome: 'allow', by: 'client' });
        // A's own answer arrives late: acknowledged, without effect.
        const late = await session(sid).respond(requestId, { type: 'permission', outcome: 'deny', scope: 'once' }, 'respond:from-a');
        expect(late.kind).toBe('ack');
        await settled('t_4');
        expect((await events(sid)).filter((e) => e.type === 'request-resolved')).toHaveLength(1);
        expect(ofKind('approval.resolved')).toHaveLength(1);
        expect(ofKind('approval.resolved')[0]!.data).toMatchObject({ outcome: 'allow' });
        expect((await task('t_4').get()).status).toBe('completed');
    });

    it('a `session`-scoped allow is listed as a grant and the same permission key is never asked again in that session', async () => {
        await agent();
        const t = await run('t_5', 'twice');
        await awaiting('t_5');
        const sid = t.sessionId!;
        const requestId = (await session(sid).get()).openRequests[0]!;
        await session(sid).respond(requestId, { type: 'permission', outcome: 'allow', scope: 'session' });
        await settled('t_5');
        expect((await task('t_5').get())).toMatchObject({ status: 'completed', result: { text: 'removed twice' } });
        const evs = await events(sid);
        // One question for two calls: the second was granted by the session.
        expect(evs.filter((e) => e.type === 'request')).toHaveLength(1);
        expect(evs.filter((e) => e.type === 'tool-update' && (e as { status: string }).status === 'completed')).toHaveLength(2);
        const grants = (await session(sid).get()).grants;
        expect(grants).toEqual([{ permissionKey: 'rm:tmp', toolName: 'rm', requestId, by: 'client', at: expect.any(Number) }]);
        expect(sessionGrantsOf(evs)).toEqual(grants);
        expect(ofKind('approval.resolved')[0]!.data).toMatchObject({ scope: 'session' });
        expect(await inbox().unread()).toBe(0);
    });

    it('an input request is an `input` notification answered the same way, and never an approval audit event', async () => {
        await agent();
        const t = await run('t_6', 'ask');
        await awaiting('t_6');
        const sid = t.sessionId!;
        const requestId = (await session(sid).get()).openRequests[0]!;
        expect((await task('t_6').get()).wait).toEqual({ kind: 'input', requestId, sessionId: sid });
        expect(await inbox().list()).toMatchObject([{ kind: 'input', title: `Ada needs input`, body: 'Which one?', ref: { kind: 'session', sessionId: sid, requestId } }]);
        expect(await statuses()).toContain(`request:input:${requestId}`);
        await session(sid).respond(requestId, { type: 'input', answers: 'the first' });
        await settled('t_6');
        expect((await task('t_6').get()).status).toBe('completed');
        expect(await inbox().unread()).toBe(0);
        expect(await statuses()).toContain(`request-resolved:input:${requestId}`);
        expect(ofKind('approval.requested')).toEqual([]);
        expect(ofKind('approval.resolved')).toEqual([]);
    });
});
