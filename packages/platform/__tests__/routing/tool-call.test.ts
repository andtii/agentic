/**
 * `createToolCallPort` — a daemon session's `tool.call` runs the platform
 * tool over the actors under the agent principal (architecture §5b, #37):
 * memory in the agent's own scope, chat posts attributed to the agent, task
 * reports kept by the router; `ask_user` raised as the session's own input
 * request and answered from `Session.respond` (#122); `delegate` without a
 * task refused as unsupported (delegation itself: `delegation.test.ts`), bad
 * input as invalid, a non-agent principal as forbidden.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actorKey, type AgentId, type ChatId, type FrozenAgentConfig, type Principal, type ProjectId, type SessionId, type TaskId, type WorkspaceId } from '@agentic/core';

import { agentMemoryScope } from '../../src/agent/index';
import { AuditActor, auditKey } from '../../src/audit/index';
import { mintAgentPrincipal, workspaceKey } from '../../src/auth/index';
import { Chat, ChatPage } from '../../src/chat/index';
import { ToolCallError, type ToolCallPort } from '../../src/machine/index';
import { Memory, memoryActorKey } from '../../src/memory/index';
import { PairingDirectory } from '../../src/pairing/index';
import { createToolCallPort, defineRoutingActor, routingKey } from '../../src/routing/index';
import { defineSessionActor, type AnswerFollowUp, type CommandSink } from '../../src/session/index';
import { Workspace } from '../../src/workspace/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const AGENT = 'agent_1' as AgentId;
const OTHER = 'agent_2' as AgentId;
const CHAT = 'chat_1' as ChatId;
const SESSION = 'session_1' as SessionId;
const TASK = 'task_1' as TaskId;
const principal = mintAgentPrincipal({ workspaceId: WS, agentId: AGENT, sessionId: SESSION, taskId: TASK });
/** The agent's other session, opened without a task, and the principal the Machine mints for it. */
const TASKLESS_SESSION = 'session_3' as SessionId;
const taskless = mintAgentPrincipal({ workspaceId: WS, agentId: AGENT, sessionId: TASKLESS_SESSION });

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
/** The same port with `ask_user`'s quick window cut to 20 ms, so a question detaches (#285). */
let quickPort: ToolCallPort;
let followUps: AnswerFollowUp[];
let Session: ReturnType<typeof defineSessionActor>;
let Routing: ReturnType<typeof defineRoutingActor>;

beforeEach(async () => {
    followUps = [];
    // A daemon path with no daemon: a prompt goes nowhere (`startTurn` acks it as the hosting machine would); a close is acked the way a daemon does, in a turn of its own.
    const commands: CommandSink = {
        send: async (t, cmd) => {
            if (cmd.type !== 'close') return;
            setTimeout(() => void app.as({ kind: 'machine', workspaceId: WS, machineId: 'machine_1' as never }).actor(Session, actorKey(WS, 'session', t.sessionId)).commandReplied({ v: 1, kind: 'ack', commandId: cmd.commandId }), 0);
        }
    };
    Session = defineSessionActor({ factory: () => null, commands, answered: async (f) => void followUps.push(f) });
    Routing = defineRoutingActor({ sessions: () => Session, machines: () => Session });
    port = createToolCallPort({ routing: () => Routing, sessions: () => Session });
    quickPort = createToolCallPort({ routing: () => Routing, sessions: () => Session, askQuickWaitMs: 20 });
    app = testActorApp([Session, Routing, Memory, Chat, ChatPage, Workspace, PairingDirectory, AuditActor]);
    await app.start();
    await app.as(owner).actor(Session, actorKey(WS, 'session', SESSION)).open({ agentId: AGENT, runtime: 'in-memory', chatId: CHAT, taskId: TASK, machineId: 'machine_1' as never, config });
    // A second, real daemon session of the same agent that works no task (#390): a chat session, say.
    await app.as(owner).actor(Session, actorKey(WS, 'session', TASKLESS_SESSION)).open({ agentId: AGENT, runtime: 'in-memory', chatId: CHAT, machineId: 'machine_1' as never, config });
});
afterEach(() => app.stop());

/** A `tool.call` as the Machine relays it: the frame's session and the principal's are the same session. */
const call = (tool: string, input: unknown, as: Principal = principal, callId = 'call_1', sessionId: SessionId = SESSION) => port.call({ callId, sessionId, tool, input }, as);
/** A turn running on `sessionId`, the way a daemon's ack starts one: a `tool.call` belongs to a running turn, and a question asked outside one is detached (#393). */
async function startTurn(sessionId: SessionId, turnId: string): Promise<void> {
    await app.as(owner).actor(Session, actorKey(WS, 'session', sessionId)).prompt('go', turnId);
    await app.as({ kind: 'machine', workspaceId: WS, machineId: 'machine_1' as never }).actor(Session, actorKey(WS, 'session', sessionId)).commandReplied({ v: 1, kind: 'ack', commandId: turnId, turnId });
}
const until = async (check: () => Promise<boolean> | boolean, what: string, timeoutMs = 4_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
};
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
        // An agent whose session works no task cannot report one. The task is the SESSION's (its running turn's, else its
        // spec's — #390), never the token's: a principal minted without one still reports for a session that has one.
        expect(await codeOf(call('task_report', { status: 'done', summary: 'x' }, taskless, 'call_1', TASKLESS_SESSION))).toBe('unsupported');
        const tokenless = mintAgentPrincipal({ workspaceId: WS, agentId: AGENT, sessionId: SESSION });
        expect(await call('task_report', { status: 'progress', summary: 'still halfway' }, tokenless)).toEqual({ ok: true, status: 'progress' });
    });

    it('ask_user raises one input request on the session (idempotent by call id); the answer from Session.respond is the tool result, a cancel a `cancelled` error (#122)', async () => {
        const session = app.as(owner).actor(Session, actorKey(WS, 'session', SESSION));
        const asked = call('ask_user', { question: 'Which colour?', choices: ['red', 'blue'] }, principal, 'call_ask');
        await until(async () => (await session.get()).openRequests.length === 1, 'the request to land');
        // The same call again (a daemon re-sending an open `tool.call` after a reconnect) finds the same request.
        const again = call('ask_user', { question: 'Which colour?', choices: ['red', 'blue'] }, principal, 'call_ask');
        const info = await session.get();
        expect(info.status).toBe('awaiting');
        expect(info.openRequests).toEqual(['ask:call_ask']);
        const record = (await session.request('ask:call_ask'))!;
        expect(record).toMatchObject({ sessionId: SESSION, agentId: AGENT, chatId: CHAT, taskId: TASK, request: { kind: 'input', toolName: 'ask_user', callId: 'call_ask', message: 'Which colour?', options: [{ id: 'red', label: 'red' }, { id: 'blue', label: 'blue' }] } });
        expect(record.resolved).toBeUndefined();
        // A permission decision is not an answer to a question.
        expect((await session.respond('ask:call_ask', { type: 'permission', outcome: 'allow', scope: 'once' }, 'respond:wrong-kind')).kind).toBe('error');
        expect((await session.respond('ask:call_ask', { type: 'input', answers: 'blue' })).kind).toBe('ack');
        expect(await asked).toEqual({ answer: 'blue' });
        expect(await again).toEqual({ answer: 'blue' });
        expect((await session.get()).openRequests).toEqual([]);
        expect((await session.request('ask:call_ask'))!.resolved).toMatchObject({ outcome: 'input', by: 'client', answers: 'blue' });
        expect((await session.events()).filter((e) => e.type === 'request')).toHaveLength(1);
        // A late second decision is a no-op ack; a cancelled question is a cancelled tool call.
        expect((await session.respond('ask:call_ask', { type: 'input', answers: 'red' }, 'respond:late')).kind).toBe('ack');
        expect((await session.request('ask:call_ask'))!.resolved).toMatchObject({ answers: 'blue' });
        const cancelled = call('ask_user', { question: 'Sure?' }, principal, 'call_cancel');
        await until(async () => (await session.get()).openRequests.length === 1, 'the second request to land');
        await session.respond('ask:call_cancel', { type: 'cancel' });
        expect(await codeOf(cancelled)).toBe('cancelled');
    });

    it('in a chat, ask_user answers `pending` once the quick window passes; an answer while the asker’s turn still runs is handed over once it is over (#285, #393)', async () => {
        const session = app.as(owner).actor(Session, actorKey(WS, 'session', SESSION));
        await startTurn(SESSION, 'turn_late');
        const out = await quickPort.call({ callId: 'call_late', sessionId: SESSION, tool: 'ask_user', input: { question: 'Which colour?', choices: ['red', 'blue'] } }, principal);
        expect(out).toMatchObject({ status: 'pending', questionId: 'ask:call_late' });
        expect(await session.request('ask:call_late')).toMatchObject({ agentName: 'Ada', detached: true });
        // Answered while the asker's turn still runs: parked, nobody started yet — the asker's next turn runs in this same session.
        expect((await session.respond('ask:call_late', { type: 'input', answers: 'blue' })).kind).toBe('ack');
        expect(followUps).toEqual([]);
        expect((await session.get()).openRequests).toEqual([]);
        // The turn is over (here: the session closes on it): the answer goes to the asker once, with who gave it.
        await session.close();
        await until(() => followUps.length === 1, 'the follow-up');
        expect(followUps[0]).toEqual({
            workspaceId: WS,
            sessionId: SESSION,
            agentId: AGENT,
            chatId: CHAT,
            taskId: TASK,
            requestId: 'ask:call_late',
            question: 'Which colour?',
            choices: ['red', 'blue'],
            answer: 'blue',
            answeredBy: owner
        });
        await new Promise((r) => setTimeout(r, 30));
        expect(followUps).toHaveLength(1);
    });

    it('detaching is atomic with respond: an answer that beat the detach is returned, never lost (#285)', async () => {
        const asAgent = app.as(principal).actor(Session, actorKey(WS, 'session', SESSION));
        const { requestId } = await asAgent.raiseInput({ callId: 'call_race', message: 'Which colour?' });
        await app.as(owner).actor(Session, actorKey(WS, 'session', SESSION)).respond(requestId, { type: 'input', answers: 'red' });
        expect(await asAgent.detachInput(requestId)).toMatchObject({ resolved: { outcome: 'input', answers: 'red' } });
        expect((await asAgent.get()).openRequests).toEqual([]);
        // Only the asking agent detaches its own question.
        const other = mintAgentPrincipal({ workspaceId: WS, agentId: OTHER, sessionId: 'session_2' as SessionId });
        await expect(app.as(other).actor(Session, actorKey(WS, 'session', SESSION)).detachInput(requestId)).rejects.toThrow();
    });

    it('without a chat, ask_user keeps waiting past the quick window: there is nowhere to start the asker again (#285)', async () => {
        const LONE = 'session_lone' as SessionId;
        const lone = mintAgentPrincipal({ workspaceId: WS, agentId: AGENT, sessionId: LONE, taskId: TASK });
        const session = app.as(owner).actor(Session, actorKey(WS, 'session', LONE));
        await session.open({ agentId: AGENT, runtime: 'in-memory', taskId: TASK, machineId: 'machine_1' as never, config });
        await startTurn(LONE, 'turn_lone');
        let answered: unknown;
        const asked = quickPort.call({ callId: 'call_lone', sessionId: LONE, tool: 'ask_user', input: { question: 'Sure?' } }, lone).then((r) => (answered = r));
        await until(async () => (await session.get()).openRequests.length === 1, 'the request to land');
        await new Promise((r) => setTimeout(r, 60));
        expect(answered).toBeUndefined();
        expect(await session.request('ask:call_lone')).toMatchObject({ detached: false });
        await session.respond('ask:call_lone', { type: 'input', answers: 'yes' });
        expect(await asked).toEqual({ answer: 'yes' });
    });

    it('refuses what it does not serve, with the code the daemon reports', async () => {
        // A session that works no task (#390): the task is the session's, so a taskless token on a task session would still delegate.
        expect(await codeOf(call('delegate', { assignee: OTHER, objective: 'x' }, taskless, 'call_1', TASKLESS_SESSION))).toBe('unsupported');
        expect(await codeOf(call('shell', {}))).toBe('unsupported');
        expect(await codeOf(call('memory_search', { nope: 1 }))).toBe('invalid');
        expect(await codeOf(call('memory_search', { query: 'x' }, { kind: 'machine', workspaceId: WS, machineId: 'machine_1' as never }))).toBe('forbidden');
    });
});

describe('createToolCallPort: projects (#334)', () => {
    // The Workspace at `ws:{userId}` is the owner's alone, and v1 pairs `workspaceId === userId`.
    const ws = () => app.as(owner).actor(Workspace, workspaceKey(WS));
    const chat = () => app.as(owner).actor(Chat, actorKey(WS, 'chat', CHAT));
    const audits = async () => (await app.as(owner).actor(AuditActor, auditKey(WS)).list({ kinds: ['chat.project-set'] })).events;

    it('a member agent lists the projects (read as the workspace user) and sets the chat’s project through tool.call; the audit carries the agent', async () => {
        const project = await ws().upsertProject({ name: 'Agentic', description: 'The agent platform' });
        await ws().upsertProject({ name: 'Zero' });
        await chat().addAgent(AGENT, 'all');
        expect(await call('projects', { action: 'list' })).toEqual({
            projects: [
                { id: project.id, name: 'Agentic', description: 'The agent platform', environments: [] },
                { id: expect.stringMatching(/^project_/), name: 'Zero', environments: [] }
            ]
        });
        expect(await call('projects', { action: 'set', chatId: CHAT, projectId: project.id })).toEqual({ chatId: CHAT, projectId: project.id, previous: null });
        expect(await chat().get()).toMatchObject({ projectId: project.id, project: { id: project.id, name: 'Agentic' } });
        expect(await audits()).toMatchObject([{ by: `agent:${AGENT}`, data: { chatId: CHAT, projectId: project.id, name: 'Agentic' } }]);
        // An unknown project is the chat's 400, as an invalid tool call; the chat is left as it was.
        expect(await codeOf(call('projects', { action: 'set', chatId: CHAT, projectId: 'project_nope', force: true }))).toBe('invalid');
        expect((await chat().get()).projectId).toBe(project.id);
    });

    it('a chat already in a project is left unchanged without force, and switched with it', async () => {
        const agentic = await ws().upsertProject({ name: 'Agentic' });
        const zero = await ws().upsertProject({ name: 'Zero' });
        await chat().addAgent(AGENT, 'all');
        await chat().setProject(agentic.id);
        await expect(call('projects', { action: 'set', chatId: CHAT, projectId: zero.id })).rejects.toThrow(/already in project "Agentic"/);
        await expect(call('projects', { action: 'set', chatId: CHAT, projectId: null })).rejects.toThrow(/already in project "Agentic"/);
        expect((await chat().get()).projectId).toBe(agentic.id);
        expect(await audits()).toHaveLength(1);
        expect(await call('projects', { action: 'set', chatId: CHAT, projectId: zero.id, force: true })).toEqual({ chatId: CHAT, projectId: zero.id, previous: { id: agentic.id, name: 'Agentic' } });
        expect((await chat().get()).projectId).toBe(zero.id);
        expect((await audits()).map((e) => [e.by, (e.data as { projectId: ProjectId }).projectId])).toEqual([
            [`agent:${AGENT}`, zero.id],
            ['user:u1', agentic.id]
        ]);
    });

    it('an agent that is not a member of the chat is refused as forbidden, and nothing is recorded', async () => {
        const project = await ws().upsertProject({ name: 'Agentic' });
        await chat().addAgent(AGENT, 'all');
        const other = mintAgentPrincipal({ workspaceId: WS, agentId: OTHER, sessionId: 'session_2' as SessionId });
        expect(await codeOf(call('projects', { action: 'set', chatId: CHAT, projectId: project.id }, other))).toBe('forbidden');
        expect((await chat().get()).projectId).toBeUndefined();
        expect(await audits()).toEqual([]);
        // Listing needs no membership: the catalogue is the workspace's.
        expect(((await call('projects', { action: 'list' }, other)) as { projects: unknown[] }).projects).toHaveLength(1);
    });
});
