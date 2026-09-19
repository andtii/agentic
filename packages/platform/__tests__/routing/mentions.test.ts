/**
 * An agent's `chat_post` @mention activates the mentioned member (#222,
 * CHT-06, COL-06): one task per explicitly mentioned member, origin the
 * message, context the chat that member may read, routed like a person's
 * post — gated by the poster's collaborators (COL-10) and one level deeper
 * than the posting task, so agents mentioning each other stop at `maxDepth`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AgentId, type ChatEntry, type ChatId, type ChatMember, type EnvironmentId, type MessageId, type PromptPart, type SessionId, type TaskId, type WorkspaceId } from '@agentic/core';
import { allowAll } from '@sigx/ai-agent';
import { mockAgent } from '@sigx/ai-agent/testing';

import { AgentActor, agentKey } from '../../src/agent/index';
import { mintAgentPrincipal } from '../../src/auth/index';
import { Chat, ChatPage } from '../../src/chat/index';
import type { IndexedEntry } from '../../src/chat/state';
import { createActorToolPorts, defineRoutingActor, type AgentPrincipal } from '../../src/routing/index';
import { mentionContract } from '../../src/routing/mentions';
import { defineSessionActor, type SessionFactory } from '../../src/session/index';
import { TaskActor, taskKey, type TaskView } from '../../src/task/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const CHAT = 'c1' as ChatId;
const ADA = 'agent_ada' as AgentId;
const BOB = 'agent_bob' as AgentId;
const CY = 'agent_cy' as AgentId;
const text = (t: string): PromptPart[] => [{ type: 'text', text: t }];

describe('mentionContract', () => {
    const msg = (seq: number, id: string, author: ChatEntry extends infer E ? (E extends { t: 'msg'; author: infer A } ? A : never) : never, t: string, parts: PromptPart[] = text(t)): IndexedEntry =>
        ({ seq, at: seq, entry: { t: 'msg', id: id as MessageId, author, parts, at: seq, mentions: [] } }) as IndexedEntry;
    const entries = [
        msg(0, 'm0', { kind: 'user' }, 'before bob joined'),
        msg(1, 'm1', { kind: 'user' }, 'hello team'),
        msg(2, 'm2', { kind: 'agent', agentId: ADA }, 'on it', [...text('on it'), { type: 'file', mediaType: 'text/plain', name: 'a.txt', url: 'agentic-file:c1/f1' }]),
        msg(3, 'm3', { kind: 'agent', agentId: ADA }, '@bob ping')
    ];
    const base = { assignee: BOB, chatId: CHAT, messageId: 'm3' as MessageId, text: '@bob ping', posterName: 'Ada', entries, nameOf: (id: AgentId) => (id === ADA ? 'Ada' : id) };

    it('carries the message as objective and origin, and only the history the member may read', () => {
        const c = mentionContract({ ...base, member: { since: 1, historyFrom: 1 } });
        expect(c.objective).toBe('@bob ping');
        expect(c.origin).toEqual({ kind: 'user', chatId: CHAT, messageId: 'm3' });
        expect(c.context[0]).toEqual({ type: 'text', text: 'Ada mentioned you in the chat.\n\nChat so far:\nUser: hello team\nAda: on it [file a.txt]' });
        expect(c.context[1]).toEqual({ type: 'file', mediaType: 'text/plain', name: 'a.txt', url: 'agentic-file:c1/f1' });
        expect(c).not.toHaveProperty('environmentId');
    });

    it("places the task in the member's folder for this chat, else the fallback environment", () => {
        const member: ChatMember = { since: 0, historyFrom: 0, workdir: { environmentId: 'env_1' as EnvironmentId, path: '/work/app' } };
        expect(mentionContract({ ...base, member, fallbackEnvironmentId: 'env_2' as EnvironmentId })).toMatchObject({ environmentId: 'env_1', workdir: '/work/app' });
        const bare = mentionContract({ ...base, member: { since: 0, historyFrom: 0 }, fallbackEnvironmentId: 'env_2' as EnvironmentId });
        expect(bare.environmentId).toBe('env_2');
        expect(bare).not.toHaveProperty('workdir');
    });
});

describe("chat_post mentions over the actors", () => {
    let app: TestActorApp;
    let Routing: ReturnType<typeof defineRoutingActor>;
    let prompts: { agent: string; input: string }[];

    const factory = (): SessionFactory => {
        const agent = mockAgent({
            respond: (input) => {
                prompts.push({ agent: 'any', input: JSON.stringify(input) });
                return [{ text: 'pong' }];
            }
        });
        return async (runtime, c) => {
            if (runtime !== 'anthropic-api') return null;
            const session = await agent.session({ policy: allowAll, signal: c.signal });
            return { session, agentId: agent.id, capabilities: agent.capabilities };
        };
    };

    beforeEach(async () => {
        prompts = [];
        const Session = defineSessionActor({ factory: factory() });
        Routing = defineRoutingActor({ sessions: () => Session, machines: () => Session });
        app = testActorApp([Routing, Session, TaskActor, AgentActor, Chat, ChatPage]);
        await app.start();
        for (const id of [ADA, BOB, CY]) {
            await app.as(owner).actor(AgentActor, agentKey(WS, id)).update({ name: id.slice(6), instructions: 'Be brief.', tools: [], approvalPolicy: [], execution: { runtime: 'anthropic-api', offlinePolicy: 'fail' } }, 'create');
            await chat().addAgent(id, 'all');
        }
    });

    afterEach(async () => {
        await app.stop();
    });

    const chat = () => app.as(owner).actor(Chat, `${WS}:chat:${CHAT}`);
    const task = (id: string) => app.as(owner).actor(TaskActor, taskKey(WS, id as TaskId));
    const until = async (check: () => Promise<boolean> | boolean, what: string): Promise<void> => {
        const deadline = Date.now() + 4_000;
        while (!(await check())) {
            if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
            await new Promise((r) => setTimeout(r, 5));
        }
    };
    /** The posting task: ADA's, created at `depth`, so the port has a task to count from. */
    async function posting(depth = 0, maxDepth?: number): Promise<TaskView> {
        return task('t_ada').create({ objective: 'coordinate', origin: { kind: 'user', chatId: CHAT, messageId: 'm_0' as MessageId }, assignee: ADA, context: [], constraints: maxDepth === undefined ? {} : { maxDepth } }, { owner: ADA, depth });
    }
    const ports = (agentId: AgentId = ADA) =>
        createActorToolPorts({ principal: mintAgentPrincipal({ workspaceId: WS, agentId, sessionId: 'session_ada' as SessionId, taskId: 't_ada' as TaskId }) as AgentPrincipal, chatId: CHAT, routing: () => Routing });
    const call = { callId: 'call_1', signal: new AbortController().signal };
    const agentMessages = async (agentId: AgentId): Promise<string[]> =>
        (await chat().history(null, 100)).entries.flatMap((e) => (e.entry.t === 'msg' && e.entry.author.kind === 'agent' && e.entry.author.agentId === agentId ? e.entry.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])) : []));

    it('starts a task for each mentioned member; it runs in the chat and its reply comes back into the chat', async () => {
        await posting();
        const result = await ports().chat.post({ text: '@bob @cy ping', mentions: [BOB, CY] }, call);
        expect(result.activated?.map((a) => a.agentId)).toEqual([BOB, CY]);
        expect(result.notActivated).toBeUndefined();
        for (const { agentId, taskId } of result.activated!) {
            const t = await task(taskId).get();
            expect(t).toMatchObject({ assignee: agentId, objective: '@bob @cy ping', origin: { kind: 'user', chatId: CHAT, messageId: result.messageId }, depth: 1 });
            expect((t.context[0] as { text: string }).text).toMatch(/^ada mentioned you in the chat\./);
            await until(async () => (await task(taskId).get()).status === 'completed', `${agentId}'s task to complete`);
        }
        await until(async () => (await agentMessages(BOB)).includes('pong') && (await agentMessages(CY)).includes('pong'), 'both replies in the chat');
    });

    it('a post without mentions wakes nobody — not the coordinator either', async () => {
        await posting();
        await chat().setCoordinator(BOB);
        const result = await ports(CY).chat.post({ text: 'done', mentions: [] }, call);
        expect(result.activated).toBeUndefined();
        expect(result.notActivated).toBeUndefined();
    });

    it("refuses a member outside the poster's collaborators, and says so", async () => {
        await posting();
        await app.as(owner).actor(AgentActor, agentKey(WS, ADA)).update({ collaborators: [CY] }, 'restrict');
        const result = await ports().chat.post({ text: '@bob @cy ping', mentions: [BOB, CY] }, call);
        expect(result.activated?.map((a) => a.agentId)).toEqual([CY]);
        expect(result.notActivated).toEqual([{ agentId: BOB, reason: 'not a collaborator of agent_ada' }]);
    });

    it('says which mentions are no member of the chat instead of dropping them; a self-mention is ignored', async () => {
        await posting();
        const result = await ports().chat.post({ text: '@bob @stranger ping', mentions: [BOB, 'agent_stranger' as AgentId, ADA] }, call);
        expect(result.activated?.map((a) => a.agentId)).toEqual([BOB]);
        expect(result.notActivated).toEqual([{ agentId: 'agent_stranger', reason: 'not a member of this chat' }]);
        expect(await ports().chat.post({ text: '@stranger', mentions: ['agent_stranger' as AgentId] }, call)).toMatchObject({ notActivated: [{ agentId: 'agent_stranger', reason: 'not a member of this chat' }] });
    });

    it('stops at the depth limit: agents mentioning each other cannot loop', async () => {
        await posting(2, 2);
        const result = await ports().chat.post({ text: '@bob again', mentions: [BOB] }, call);
        expect(result.activated).toBeUndefined();
        expect(result.notActivated).toEqual([{ agentId: BOB, reason: expect.stringMatching(/^depth limit: delegation depth 3 exceeds maxDepth 2/) }]);
        // The message itself is stored.
        expect((await chat().history(null, 10)).entries.some((e) => e.entry.t === 'msg' && e.entry.id === result.messageId)).toBe(true);
    });
});
