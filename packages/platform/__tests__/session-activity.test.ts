/**
 * A running task's latest tool call as its activity line (#955): the Session actor notes a short line on the turn's
 * task (`Task.note({ activity })`, one-way, throttled) for every `tool-call` it records — both paths — so the Work
 * view says "Running pnpm test" instead of "Working".
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actorKey, type AgentId, type FrozenAgentConfig, type MachineId, type Principal, type SessionId, type TaskId, type WorkspaceId } from '@agentic/core';
import { allowTools, firstMatch, type AgentSession } from '@sigx/ai-agent';
import { mockAgent, type MockAgent } from '@sigx/ai-agent/testing';
import { serveSession, type WireCommand, type WireFrame } from '@sigx/ai-agent/wire';

import { ACTIVITY_THROTTLE_MS, shouldNoteActivity, toolActivity } from '../src/session/activity';
import { defineSessionActor, type CommandSink, type SessionFactory } from '../src/session/index';
import { TaskActor, taskKey } from '../src/task/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const machine: Principal = { kind: 'machine', workspaceId: WS, machineId: 'machine_1' as MachineId };
const ADA = 'agent_ada' as AgentId;
const A = 'task_a' as TaskId;

const config: FrozenAgentConfig = {
    agentId: ADA,
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

describe('toolActivity', () => {
    it('prefers the runtime title, then a command, then a file by its base name, else the tool', () => {
        expect(toolActivity({ name: 'Bash', title: 'Run the tests', input: { command: 'pnpm test' } })).toBe('Run the tests');
        expect(toolActivity({ name: 'Bash', input: { command: 'pnpm   test\n --run' } })).toBe('Running pnpm test --run');
        expect(toolActivity({ name: 'Edit', input: { file_path: 'C:\\repo\\apps\\web\\src\\live.ts' } })).toBe('Editing live.ts');
        expect(toolActivity({ name: 'Write', input: { file_path: '/repo/README.md' } })).toBe('Editing README.md');
        expect(toolActivity({ name: 'Read', input: { file_path: '/repo/src/a.ts' } })).toBe('Reading a.ts');
        expect(toolActivity({ name: 'Grep', input: { pattern: 'x' } })).toBe('Using Grep');
        expect(toolActivity({ name: 'task_report' })).toBe('Using task_report');
    });
});

describe('shouldNoteActivity', () => {
    it('notes the first call, another task at once, and the same task only once the throttle has passed', () => {
        expect(shouldNoteActivity(undefined, A, 0)).toBe(true);
        expect(shouldNoteActivity({ taskId: A, at: 1_000 }, A, 1_000 + ACTIVITY_THROTTLE_MS - 1)).toBe(false);
        expect(shouldNoteActivity({ taskId: A, at: 1_000 }, A, 1_000 + ACTIVITY_THROTTLE_MS)).toBe(true);
        expect(shouldNoteActivity({ taskId: A, at: 1_000 }, 'task_b' as TaskId, 1_001)).toBe(true);
    });
});

/** Runs `pnpm test` through the Bash tool, then answers — every tool allowed, so the turn never waits. */
function scriptedAgent(): MockAgent {
    return mockAgent({
        respond: () => [{ tool: { name: 'Bash', input: { command: 'pnpm test' }, output: 'ok' } }, { text: 'tests pass' }]
    });
}

async function until(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 4_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
}

let app: TestActorApp;
let agent: MockAgent;
let Session: ReturnType<typeof defineSessionActor>;
const sent: WireCommand[] = [];
const sink: CommandSink = { send: async (_target, command) => void sent.push(command) };

beforeEach(async () => {
    sent.length = 0;
    agent = scriptedAgent();
    const factory: SessionFactory = async (runtime, c) => {
        if (runtime !== 'anthropic-api') return null;
        const session = await agent.session({ policy: firstMatch(allowTools(['Bash'])), signal: c.signal, ...(c.resume ? { resume: c.resume } : {}) });
        return { session, agentId: agent.id, capabilities: agent.capabilities };
    };
    Session = defineSessionActor({ factory, commands: sink });
    app = testActorApp([Session, TaskActor]);
    await app.start();
});
afterEach(() => app.stop());

const session = (id: string, principal: Principal = owner) => app.as(principal).actor(Session, actorKey(WS, 'session', id));
const task = (id: TaskId) => app.as(owner).actor(TaskActor, taskKey(WS, id));

async function activeTask(sessionId: SessionId): Promise<void> {
    await task(A).create({ objective: 'run the tests', origin: { kind: 'external', clientId: 'c1' }, assignee: ADA, context: [], constraints: {} }, { owner: ADA });
    await task(A).start('user:u1', sessionId);
}

describe('a tool call of a task turn is its task activity (#955)', () => {
    it('local path', async () => {
        await activeTask('session_1' as SessionId);
        await session('session_1').open({ agentId: ADA, runtime: 'anthropic-api', taskId: A, config });
        expect((await task(A).get()).activity).toBeUndefined();
        await session('session_1').prompt('go', 't1');
        await until(async () => (await task(A).get()).activity === 'Running pnpm test', 'the activity line');
        expect((await task(A).get()).status).toBe('active');
    });

    it('daemon path', async () => {
        await activeTask('session_2' as SessionId);
        await session('session_2').open({ agentId: ADA, runtime: 'claude-code', taskId: A, machineId: 'machine_1' as MachineId, config });
        const upstream: AgentSession = await agent.session({ policy: firstMatch(allowTools(['Bash'])) });
        const served = serveSession(upstream, { agentId: agent.id, capabilities: agent.capabilities });
        const frames: WireFrame[] = [];
        const pump = (async () => {
            for await (const f of served.events({ epoch: 0, seq: 0 })) frames.push(f);
        })();
        const asMachine = session('session_2', machine);

        await session('session_2').prompt('go', 't1');
        for (const command of sent.splice(0)) await asMachine.commandReplied(await served.handleCommand(command));
        await until(() => frames.some((f) => f.kind === 'event' && f.event.type === 'turn-end'), 'the turn to end upstream');
        await asMachine.forwardFrames(frames.splice(0));
        await until(async () => (await task(A).get()).activity === 'Running pnpm test', 'the activity line');

        await served.close();
        await upstream.close();
        await pump;
    });

    it('a session with no task notes nothing', async () => {
        await activeTask('session_3' as SessionId);
        await session('session_3').open({ agentId: ADA, runtime: 'anthropic-api', config });
        await session('session_3').prompt('go', 't1');
        await until(async () => !(await session('session_3').get()).running, 'the turn to end');
        expect((await task(A).get()).activity).toBeUndefined();
    });
});
