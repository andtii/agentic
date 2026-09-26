/**
 * `pull_report` over the actors (#793): `createActorToolPorts({ pulls }).pulls` reports the PR an agent opened to the
 * Pulls actor of its chat's project, under the agent's principal, linked to the task, chat and session — the task
 * then waits on the PR. Without a chat, a project or the Pulls definition the tool says why. `Pulls.get` refuses a
 * malformed key like every other method.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actorKey, type AgentId, type ChatId, type MessageId, type ProjectId, type PullRequest, type SessionId, type TaskId, type WorkspaceId } from '@agentic/core';
import { grantedPlatformTools, pullReportTool } from '@agentic/runtimes';

import { AgentActor } from '../../src/agent/index';
import { AuditActor } from '../../src/audit/index';
import { mintAgentPrincipal, workspaceKey } from '../../src/auth/index';
import { Chat, ChatPage } from '../../src/chat/index';
import { ToolCallError } from '../../src/machine/index';
import { definePullsActor, pullsKey, type PullSource } from '../../src/pulls/index';
import { createActorToolPorts, DEFAULT_TOOL_FAMILIES, PULL_TOOL_NAMES, type AgentPrincipal } from '../../src/routing/index';
import { TaskActor, taskKey } from '../../src/task/index';
import { statusOf, testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';
import { Workspace } from '../../src/workspace/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const AGENT = 'agent_1' as AgentId;
const CHAT = 'chat_1' as ChatId;
const SESSION = 'session_1' as SessionId;
const TASK = 'task_1' as TaskId;
const principal = mintAgentPrincipal({ workspaceId: WS, agentId: AGENT, sessionId: SESSION, taskId: TASK }) as AgentPrincipal;
const call = (id = 'c1') => ({ callId: id, signal: new AbortController().signal });

const pr = (number: number): PullRequest => ({
    provider: 'github',
    repo: 'o/r',
    number,
    title: `PR ${number}`,
    url: `https://github.com/o/r/pull/${number}`,
    head: 'chat/abc',
    base: 'main',
    state: 'open',
    additions: 1,
    deletions: 0,
    files: 1,
    openedBy: 'forge',
    openedAt: 0,
    checks: [],
    review: { state: 'none', reviewers: [], threads: [] }
});

let app: TestActorApp;
let Pulls: ReturnType<typeof definePullsActor>;
const prs = new Map<number, PullRequest>();
const source: PullSource = { get: async (_r, n) => prs.get(n), listOpen: async () => [...prs.values()] };

beforeEach(async () => {
    prs.clear();
    Pulls = definePullsActor({ sources: { open: () => source } });
    app = testActorApp([Pulls, TaskActor, Chat, ChatPage, Workspace, AuditActor, AgentActor]);
    await app.start();
});
afterEach(() => app.stop());

const chat = () => app.as(owner).actor(Chat, actorKey(WS, 'chat', CHAT));
const pulls = (projectId: ProjectId) => app.as(owner).actor(Pulls, pullsKey(WS, projectId));
const task = () => app.as(owner).actor(TaskActor, taskKey(WS, TASK));

async function chatInProject(): Promise<ProjectId> {
    const project = await app.as(owner).actor(Workspace, workspaceKey(WS)).upsertProject({ name: 'Agentic' });
    await chat().addAgent(AGENT, 'all');
    await chat().setProject(project.id);
    return project.id;
}

describe('pull_report (#793)', () => {
    it('is the pulls tool family, granted with the feature', () => {
        expect(DEFAULT_TOOL_FAMILIES['pulls']).toEqual(PULL_TOOL_NAMES.map((name) => ({ name })));
        const ports = createActorToolPorts({ principal, chatId: CHAT, pulls: () => Pulls });
        expect(grantedPlatformTools(ports, [{ name: 'pull_report' }]).map((t) => t.name)).toEqual(['pull_report']);
    });

    it("reports the PR to the chat's project, linked to the task, chat and session; the active task waits on it", async () => {
        const projectId = await chatInProject();
        await pulls(projectId).watch({ provider: 'github', repo: 'o/r' });
        prs.set(42, pr(42));
        await task().create({ objective: 'ship it', origin: { kind: 'user', chatId: CHAT, messageId: 'msg_1' as MessageId }, assignee: AGENT, context: [], constraints: {} }, { owner: AGENT });
        await task().start('user:u1', SESSION);

        const ports = createActorToolPorts({ principal, chatId: CHAT, pulls: () => Pulls });
        const [tool] = grantedPlatformTools(ports, [{ name: 'pull_report' }]);
        const out = await tool!.run({ number: 42 }, { toolCallId: 'c1', signal: new AbortController().signal });
        expect(out).toMatchObject({ number: 42, repo: 'o/r', state: 'open', title: 'PR 42', url: 'https://github.com/o/r/pull/42' });
        expect((await pulls(projectId).get()).pulls[0]).toMatchObject({ number: 42, taskId: TASK, chatId: CHAT, sessionId: SESSION });
        expect(await task().get()).toMatchObject({ status: 'waiting', wait: { kind: 'pull-request', number: 42, state: 'open' } });
    });

    it('keeps a report for a repo not watched yet, and says so', async () => {
        await chatInProject();
        const ports = createActorToolPorts({ principal, chatId: CHAT, pulls: () => Pulls });
        const out = await ports.pulls!.report(7, call());
        expect(out).toMatchObject({ number: 7 });
        expect(out.note).toMatch(/not watched/);
    });

    it('refuses outside a chat or a project, and without the Pulls actor the tool says it is unavailable', async () => {
        const codeOf = async (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => (e instanceof ToolCallError ? e.code : String(e)));
        expect(await codeOf(createActorToolPorts({ principal, pulls: () => Pulls }).pulls!.report(1, call()))).toBe('unsupported');
        await chat().addAgent(AGENT, 'all');
        expect(await codeOf(createActorToolPorts({ principal, chatId: CHAT, pulls: () => Pulls }).pulls!.report(1, call()))).toBe('unsupported');
        const bare = createActorToolPorts({ principal, chatId: CHAT });
        expect(bare.pulls).toBeUndefined();
        await expect(pullReportTool(bare.pulls).run({ number: 1 }, { toolCallId: 'c2', signal: new AbortController().signal })).rejects.toThrow(/not available on this host/);
    });
});

describe('Pulls.get', () => {
    it('refuses a malformed key', async () => {
        expect(await statusOf(app.as(owner).actor(Pulls, `${WS}:pulls:`).get())).toBe(400);
    });
});
