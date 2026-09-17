/**
 * `createToolCallPort` — a daemon session's `tool.call` runs the platform
 * tool over the actors under the agent principal (architecture §5b, #37):
 * memory in the agent's own scope, chat posts attributed to the agent, task
 * reports kept by the router; `delegate` without a task and `ask_user`
 * refused as unsupported (delegation itself: `delegation.test.ts`), bad
 * input as invalid, a non-agent principal as forbidden.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actorKey, type AgentId, type ChatId, type FrozenAgentConfig, type Principal, type SessionId, type TaskId, type WorkspaceId } from '@agentic/core';

import { agentMemoryScope } from '../../src/agent/index';
import { mintAgentPrincipal } from '../../src/auth/index';
import { Chat } from '../../src/chat/index';
import { ToolCallError, type ToolCallPort } from '../../src/machine/index';
import { Memory, memoryActorKey } from '../../src/memory/index';
import { createToolCallPort, defineRoutingActor, routingKey } from '../../src/routing/index';
import { defineSessionActor } from '../../src/session/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const AGENT = 'agent_1' as AgentId;
const OTHER = 'agent_2' as AgentId;
const CHAT = 'chat_1' as ChatId;
const SESSION = 'session_1' as SessionId;
const TASK = 'task_1' as TaskId;
const principal = mintAgentPrincipal({ workspaceId: WS, agentId: AGENT, sessionId: SESSION, taskId: TASK });

const config: FrozenAgentConfig = {
    agentId: AGENT,
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
    execution: { runtime: 'in-memory', limits: {}, offlinePolicy: 'fail' },
    collaborators: 'all'
};

let app: TestActorApp;
let port: ToolCallPort;
let Session: ReturnType<typeof defineSessionActor>;
let Routing: ReturnType<typeof defineRoutingActor>;

beforeEach(async () => {
    Session = defineSessionActor({ factory: () => null });
    Routing = defineRoutingActor({ sessions: () => Session, machines: () => Session });
    port = createToolCallPort({ routing: () => Routing, sessions: () => Session });
    app = testActorApp([Session, Routing, Memory, Chat]);
    await app.start();
    await app.as(owner).actor(Session, actorKey(WS, 'session', SESSION)).open({ agentId: AGENT, runtime: 'in-memory', chatId: CHAT, taskId: TASK, machineId: 'machine_1' as never, config });
});
afterEach(() => app.stop());

const call = (tool: string, input: unknown, as: Principal = principal, callId = 'call_1') => port.call({ callId, sessionId: SESSION, tool, input }, as);
const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => {
    try {
        await p;
        return undefined;
    } catch (e) {
        return e instanceof ToolCallError ? e.code : `not-a-tool-call-error: ${String(e)}`;
    }
};

describe('createToolCallPort', () => {
    it('memory_remember stores in the agent scope with the session and task as provenance; memory_search finds it', async () => {
        const stored = (await call('memory_remember', { text: 'The user drinks tea.', kind: 'preference', tags: ['drinks'] })) as { id: string; kind: string; confidence: string };
        expect(stored).toMatchObject({ kind: 'preference', confidence: 'stated' });
        const entry = await app.as(owner).actor(Memory, memoryActorKey(WS, agentMemoryScope(AGENT))).get(stored.id);
        expect(entry?.provenance).toMatchObject({ source: 'agent', sessionId: SESSION, taskId: TASK });
        const found = (await call('memory_search', { query: 'tea' })) as { memories: { id: string; text: string }[] };
        expect(found.memories.map((m) => m.id)).toEqual([stored.id]);
        // Another agent's memory is not this agent's.
        const other = mintAgentPrincipal({ workspaceId: WS, agentId: OTHER, sessionId: 'session_2' as SessionId });
        expect(((await call('memory_search', { query: 'tea' }, other)) as { memories: unknown[] }).memories).toEqual([]);
    });

    it('chat_post posts into the session chat in the agent name, tagged with the task', async () => {
        const chat = app.as(owner).actor(Chat, actorKey(WS, 'chat', CHAT));
        await chat.addAgent(AGENT, 'all');
        const result = (await call('chat_post', { text: 'Done: the report is ready.' })) as { messageId: string };
        expect(result.messageId).toMatch(/^msg_/);
        const page = await chat.history(null, 10);
        const last = page.entries[page.entries.length - 1]!.entry;
        expect(last).toMatchObject({ t: 'msg', id: result.messageId, author: { kind: 'agent', agentId: AGENT, sessionId: SESSION }, taskId: TASK });
    });

    it('task_report is kept by the router for the task the agent works', async () => {
        expect(await call('task_report', { status: 'progress', summary: 'halfway' })).toEqual({ ok: true, status: 'progress' });
        expect((await app.as(owner).actor(Routing, routingKey(WS)).get()).reports).toEqual({ [TASK]: { status: 'progress', summary: 'halfway' } });
        // An agent without a task cannot report one.
        const taskless = mintAgentPrincipal({ workspaceId: WS, agentId: AGENT, sessionId: SESSION });
        expect(await codeOf(call('task_report', { status: 'done', summary: 'x' }, taskless))).toBe('unsupported');
    });

    it('refuses what it does not serve, with the code the daemon reports', async () => {
        const taskless = mintAgentPrincipal({ workspaceId: WS, agentId: AGENT, sessionId: SESSION });
        expect(await codeOf(call('delegate', { assignee: OTHER, objective: 'x' }, taskless))).toBe('unsupported');
        expect(await codeOf(call('ask_user', { question: 'Which?' }))).toBe('unsupported');
        expect(await codeOf(call('shell', {}))).toBe('unsupported');
        expect(await codeOf(call('memory_search', { nope: 1 }))).toBe('invalid');
        expect(await codeOf(call('memory_search', { query: 'x' }, { kind: 'machine', workspaceId: WS, machineId: 'machine_1' as never }))).toBe('forbidden');
    });
});
