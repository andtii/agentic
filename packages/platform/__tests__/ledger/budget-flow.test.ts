/**
 * Session → Ledger → Task over `mockAgent`: every turn-scoped `usage` event
 * becomes a priced, flagged ledger row (OPS-07); a task past its budget ends
 * `failed {budget}`, its running turn is cancelled and its children are not
 * started (COL-11, OPS-08). Offline and deterministic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actorKey, type AgentId, type FrozenAgentConfig, type MachineId, type Principal, type SessionId, type TaskContract, type TaskId, type WorkspaceId } from '@agentic/core';
import { allowAll, type AgentEvent } from '@sigx/ai-agent';
import { mockAgent, type MockAgent } from '@sigx/ai-agent/testing';
import type { WireCommand, WireFrame } from '@sigx/ai-agent/wire';

import { LedgerActor, ledgerKey, ledgerMonth, ledgerRecorder } from '../../src/ledger/index';
import { defineSessionActor, type CommandSink, type SessionFactory, type SessionOpenSpec } from '../../src/session/index';
import { TaskActor, TaskLimitError, taskKey } from '../../src/task/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const machine: Principal = { kind: 'machine', workspaceId: WS, machineId: 'machine_1' as MachineId };
const PRICED = 'agent_1' as AgentId; // its factory prices rows (at a guessed rate)
const PLAIN = 'agent_2' as AgentId; // no pricing: the event's own cost, or none

const config = (agentId: AgentId): FrozenAgentConfig => ({
    agentId,
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
});
const spec = (agentId: AgentId, taskId?: TaskId): SessionOpenSpec => ({ agentId, runtime: 'anthropic-api', ...(taskId ? { taskId } : {}), config: config(agentId) });
const contract = (assignee: AgentId, constraints: TaskContract['constraints']): TaskContract => ({
    objective: 'do the thing',
    origin: { kind: 'external', clientId: 'c1' },
    assignee,
    context: [],
    constraints
});

const USAGE = { inputTokens: 100, outputTokens: 50 };

/** `cheap` costs 0.4, `dear` costs 0.7 and then runs a long tool, `free` reports tokens but no cost. */
function scriptedAgent(): MockAgent {
    return mockAgent({
        respond: (input) => {
            const text = input.map((p) => (p.type === 'text' ? p.text : '')).join('');
            if (text === 'cheap') return [{ usage: USAGE, costUsd: 0.4 }, { text: 'ok' }];
            if (text === 'dear') return [{ usage: USAGE, costUsd: 0.7 }, { tool: { name: 'slow', input: {}, output: 'x', delayMs: 2_000 } }, { text: 'after' }];
            if (text === 'free') return [{ usage: { inputTokens: 5, outputTokens: 1 } }, { text: 'free' }];
            // Claude Code's thinking-token ticks: an estimate per tick, nothing billed.
            if (text === 'think') return [{ usage: { reasoningTokens: 3 } }, { usage: { reasoningTokens: 4, inputTokens: 0, outputTokens: 0 } }, { text: 'thought' }];
            return [{ text: `echo: ${text}` }];
        }
    });
}

function factory(agent: MockAgent): SessionFactory {
    return async (runtime, c) => {
        if (runtime !== 'anthropic-api') return null;
        const session = await agent.session({ policy: allowAll, signal: c.signal });
        const usageRow: NonNullable<Awaited<ReturnType<SessionFactory>>>['usageRow'] = (event, at) => ({
            ...at,
            agentId: c.spec.agentId,
            usage: event.usage ?? { inputTokens: 0, outputTokens: 0 },
            costUsd: event.costUsd ?? 0,
            estimated: true
        });
        return { session, agentId: agent.id, capabilities: agent.capabilities, ...(c.spec.agentId === PRICED ? { usageRow } : {}) };
    };
}

async function until(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let app: TestActorApp;
let Session: ReturnType<typeof defineSessionActor>;
const sent: WireCommand[] = [];
const sink: CommandSink = { send: async (_target, command) => void sent.push(command) };

beforeEach(() => {
    sent.length = 0;
    Session = defineSessionActor({ factory: factory(scriptedAgent()), commands: sink, usage: ledgerRecorder() });
    app = testActorApp([Session, LedgerActor, TaskActor]);
    return app.start();
});
afterEach(() => app.stop());

const session = (id: string, principal: Principal = owner) => app.as(principal).actor(Session, actorKey(WS, 'session', id));
const task = (id: string) => app.as(owner).actor(TaskActor, taskKey(WS, id as TaskId));
const ledger = () => app.as(owner).actor(LedgerActor, ledgerKey(WS, ledgerMonth(Date.now())));
const settled = (id: string) => until(async () => !(await session(id).get()).running, `session ${id} to settle`);

describe('usage → Ledger (OPS-07)', () => {
    it('records every turn-scoped usage event as a row priced by the runtime, flagged as an estimate, and charges the task', async () => {
        await task('task_1').create(contract(PRICED, { maxCostUsd: 1 }), { owner: PRICED });
        await task('task_1').start('user:u1', 'session_1' as SessionId);
        await session('session_1').open(spec(PRICED, 'task_1' as TaskId));
        await session('session_1').prompt('cheap', 't1');
        await settled('session_1');

        const rows = await ledger().rows();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ sessionId: 'session_1', agentId: PRICED, taskId: 'task_1', turnId: 't1', usage: USAGE, costUsd: 0.4, estimated: true });
        expect(rows[0]!.key).toMatch(/:1:\d+$/);
        const view = await task('task_1').get();
        expect(view.status).toBe('active');
        expect(view.costUsd).toBeCloseTo(0.4);
        expect(view.usage).toEqual(USAGE);
        const summary = await ledger().summary({ by: 'task' });
        expect(summary.groups).toHaveLength(1);
        expect(summary.groups[0]).toMatchObject({ key: 'task_1', costUsd: 0.4, estimatedCostUsd: 0.4, quality: 'estimated' });
    });

    it('records a row without a cost as unavailable, never as zero, and charges no task', async () => {
        await session('session_2').open(spec(PLAIN));
        await session('session_2').prompt('free', 'f1');
        await settled('session_2');
        const rows = await ledger().rows({ agentId: PLAIN });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ agentId: PLAIN, usage: { inputTokens: 5, outputTokens: 1 }, estimated: false });
        expect(rows[0]!.costUsd).toBeUndefined();
        expect(rows[0]!.taskId).toBeUndefined();
        const summary = await ledger().summary({ by: 'agent', agentId: PLAIN });
        expect(summary.total).toMatchObject({ rows: 1, costUsd: null, unpricedRows: 1, quality: 'not-reported' });
    });

    it('records no row for a usage event with nothing billed — a thinking-token tick — and charges no task', async () => {
        await task('task_4').create(contract(PRICED, { maxCostUsd: 1 }), { owner: PRICED });
        await task('task_4').start('user:u1', 'session_4' as SessionId);
        await session('session_4').open(spec(PLAIN, 'task_4' as TaskId));
        await session('session_4').prompt('think', 'k1');
        await settled('session_4');
        expect(await ledger().rows()).toEqual([]);
        expect((await task('task_4').get()).usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    });
});

describe('budgets stop work (COL-11, OPS-08)', () => {
    it('a task over budget ends failed {budget}, its turn is cancelled and it can no longer delegate', async () => {
        await task('task_1').create(contract(PRICED, { maxCostUsd: 1 }), { owner: PRICED });
        await task('task_1').start('user:u1', 'session_1' as SessionId);
        await session('session_1').open(spec(PRICED, 'task_1' as TaskId));
        await session('session_1').prompt('cheap', 't1');
        await settled('session_1');
        expect((await task('task_1').get()).status).toBe('active');

        await session('session_1').prompt('dear', 't2');
        await until(async () => (await task('task_1').get()).status === 'failed', 'the task to fail');
        await settled('session_1');

        const view = await task('task_1').get();
        expect(view.error).toMatchObject({ code: 'budget', recoverable: false });
        expect(view.error!.message).toMatch(/maxCostUsd 1 reached \(spent 1\.1/);
        expect(view.costUsd).toBeCloseTo(1.1);
        expect(view.transitions.at(-1)).toMatchObject({ from: 'active', to: 'failed', by: 'system:budget', why: 'failed: budget' });

        const events = await session('session_1').events();
        const end = events.find((e): e is Extract<AgentEvent, { type: 'turn-end' }> => e.type === 'turn-end' && e.turnId === 't2');
        expect(end?.stopReason).toBe('cancelled');
        expect(events.some((e) => e.type === 'tool-update' && e.status === 'cancelled')).toBe(true);
        expect((await ledger().summary({ by: 'task' })).groups[0]).toMatchObject({ key: 'task_1', rows: 2, costUsd: 1.1 });

        await expect(task('task_1').delegate({ callId: 'c1', objective: 'more', assignee: PLAIN })).rejects.toThrow(/only an active task delegates/);
    });

    it('a queued child of a task that runs out of budget is cancelled, never started', async () => {
        await task('task_1').create(contract(PRICED, { maxCostUsd: 1 }), { owner: PRICED });
        await task('task_1').start('user:u1', 'session_1' as SessionId);
        const childId = await task('task_1').delegate({ callId: 'c1', objective: 'sub', assignee: PLAIN });
        expect((await task(childId).get()).status).toBe('queued');

        await task('task_1').recordUsage(USAGE, 1);
        expect(await task('task_1').get()).toMatchObject({ status: 'failed', error: { code: 'budget' } });
        await until(async () => (await task(childId).get()).status === 'cancelled', 'the child to be cancelled');
        const child = await task(childId).get();
        expect(child.transitions.map((t) => t.to)).toEqual(['cancelled']);
    });

    it('delegating past the wall-clock budget fails the task and creates no child', async () => {
        await task('task_1').create(contract(PRICED, { maxWallMs: 5 }), { owner: PRICED });
        await task('task_1').start('user:u1', 'session_1' as SessionId);
        await sleep(20);
        const attempt = task('task_1').delegate({ callId: 'c1', objective: 'sub', assignee: PLAIN });
        await expect(attempt).rejects.toMatchObject({ name: TaskLimitError.name, kind: 'budget', limit: 'maxWallMs' });
        const failed = await task('task_1').get();
        expect(failed).toMatchObject({ status: 'failed', error: { code: 'budget' }, children: [] });
        expect(failed.transitions.at(-1)).toMatchObject({ to: 'failed', by: 'system:budget' });
        await expect(task('task_1.c1').get()).rejects.toThrow(/has not been created/);
    });

    it('on the daemon path the cancel travels the CommandSink and session-scoped totals are never counted', async () => {
        await task('task_3').create(contract(PRICED, { maxCostUsd: 1 }), { owner: PRICED });
        await task('task_3').start('user:u1', 'session_3' as SessionId);
        await session('session_3').open({ ...spec(PRICED, 'task_3' as TaskId), runtime: 'claude-code', machineId: 'machine_1' as MachineId });
        expect((await session('session_3').prompt('go', 't1')).kind).toBe('pending');
        const asMachine = session('session_3', machine);
        await asMachine.commandReplied({ v: 1, kind: 'ack', commandId: 't1', turnId: 't1' });
        const frame = (seq: number, event: Omit<AgentEvent, 'sessionId' | 'epoch' | 'seq'>): WireFrame =>
            ({ v: 1, kind: 'event', epoch: 1, seq, event: { ...event, sessionId: 'remote', epoch: 1, seq } }) as WireFrame;
        await asMachine.forwardFrames([
            frame(1, { type: 'turn-start', turnId: 't1', input: [{ type: 'text', text: 'go' }] } as never),
            frame(2, { type: 'usage', scope: 'session', turnId: 't1', usage: USAGE, costUsd: 5 } as never),
            frame(3, { type: 'usage', scope: 'turn', turnId: 't1', usage: USAGE, costUsd: 2 } as never)
        ]);
        expect(await task('task_3').get()).toMatchObject({ status: 'failed', error: { code: 'budget' }, costUsd: 2 });
        expect(sent.map((c) => c.type)).toEqual(['prompt', 'cancel']);
        const rows = await ledger().rows({ taskId: 'task_3' });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ key: 'remote:1:3', costUsd: 2, estimated: false });
    });
});
