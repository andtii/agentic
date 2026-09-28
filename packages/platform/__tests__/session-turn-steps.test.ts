/**
 * A turn's steps on its final chat message (#1055; CHT-09, COL-09): the Session folds the turn's tool calls into
 * `TurnSteps` through the runtime's normalisers and attaches them to the `message` it publishes; the Chat keeps them on
 * the `msg`, and they survive `Chat.history` paging. `foldTurnSteps` itself: diffs, sub-agent calls, the cap and the
 * size of one turn's summary.
 */
import { actorKey, formatStepSummary, summariseSteps, turnOpensItself, type AgentId, type ChatEntry, type ChatId, type FrozenAgentConfig, type TaskId, type WorkspaceId } from '@agentic/core';
import { allowAll, type AgentEvent } from '@sigx/ai-agent';
import { mockAgent } from '@sigx/ai-agent/testing';

import { Chat, ChatPage } from '../src/chat/index';
import { defineSessionActor, foldTurnSteps, SessionPage, TURN_EXCERPTS_MAX, TURN_STEPS_CAP, type SessionFactory } from '../src/session/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const AGENT = 'agent_ada' as AgentId;
const CHAT = 'chat_steps' as ChatId;
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
    execution: { runtime: 'claude-code', limits: {}, offlinePolicy: 'fail' },
    collaborators: 'all'
};

const FAILED_OUTPUT = ['Exit code 1', '> vitest run', ' RUN  v4', ' FAIL  src/a.test.ts > adds', 'AssertionError: expected 3 to be 4', '    at src/a.test.ts:4:13', ' Test Files  1 failed (1)'].join('\n');

/** A Claude Code turn: a failed Bash, a read, the same Bash again (recovered), then the answer. */
const factory: SessionFactory = async (runtime, c) => {
    if (runtime !== 'claude-code') return null;
    const agent = mockAgent({
        respond: () => [
            { tool: { name: 'Bash', category: 'execute', input: { command: 'pnpm test' }, status: 'failed', error: FAILED_OUTPUT } },
            { tool: { name: 'Read', category: 'read', input: { file_path: '/work/src/a.ts' }, output: '1\texport const add = (a, b) => a + b;' } },
            { tool: { name: 'Bash', category: 'execute', input: { command: 'pnpm test' }, output: ' Test Files  1 passed (1)' } },
            { text: 'Fixed: the test passes now.' }
        ]
    });
    const session = await agent.session({ policy: allowAll, signal: c.signal });
    return { session, agentId: agent.id, capabilities: agent.capabilities };
};

async function until(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
}

let app: TestActorApp;
let t = 1_790_000_000_000;
beforeEach(() => {
    // Every read of the clock is a second later (the mock may stamp its own time, which wins).
    const Session = defineSessionActor({ factory, now: () => (t += 1_000) });
    app = testActorApp([Session, SessionPage, Chat, ChatPage]);
    return app.start().then(() => {
        session = () => app.as(owner).actor(Session, actorKey(WS, 'session', 'session_1'));
    });
});
afterEach(() => app.stop());

let session: () => { open: (spec: never) => Promise<unknown>; prompt: (text: string, id: string) => Promise<unknown>; get: () => Promise<{ running?: unknown }> };
const chat = () => app.as(owner).actor(Chat, actorKey(WS, 'chat', CHAT));

type Msg = Extract<ChatEntry, { t: 'msg' }>;
const agentMsgs = async (): Promise<Msg[]> => {
    const out: Msg[] = [];
    let cursor: number | null = null;
    do {
        const page = await chat().history(cursor, 100);
        for (const e of page.entries) if (e.entry.t === 'msg' && e.entry.author.kind === 'agent') out.push(e.entry);
        cursor = page.next;
    } while (cursor !== null);
    return out;
};

describe('a turn step summary on the final chat msg (#1055)', { timeout: 60_000 }, () => {
    it('a failed Bash and its recovery end in a msg whose steps hold the summary, the excerpt and the durations — and survive history paging', async () => {
        await session().open({ agentId: AGENT, runtime: 'claude-code', chatId: CHAT, taskId: 'task_1' as TaskId, config } as never);
        await session().prompt('fix the test', 'c1');
        await until(async () => (await agentMsgs()).length === 1, 'the agent message');

        const [msg] = await agentMsgs();
        const steps = msg!.steps!;
        expect(steps).toBeDefined();
        expect(steps.total).toBe(3);
        expect(steps.steps.map((s) => [s.tool, s.kind, s.target, s.state, s.exitCode])).toEqual([
            ['Bash', 'command', 'pnpm test', 'error', 1],
            ['Read', 'read', '/work/src/a.ts', 'done', undefined],
            ['Bash', 'command', 'pnpm test', 'done', 0]
        ]);
        const [failed, read, retried] = steps.steps;
        // The excerpt only on the failure: the lines naming the error, with the ref to the full output in the Session.
        expect(failed!.output).toMatchObject({ picked: 'error', lines: 7, ref: `session_1#${failed!.id}` });
        expect(failed!.output!.excerpt).toContain('AssertionError: expected 3 to be 4');
        expect(read!.output).toBeUndefined();
        expect(retried!.output).toBeUndefined();
        for (const s of steps.steps) {
            expect(s.agentId).toBe(AGENT);
            expect(s.turnId).toBe(steps.turnId);
            expect(s.endedAt! - s.startedAt!).toBeGreaterThanOrEqual(0);
        }
        expect(steps.endedAt! - steps.startedAt!).toBeGreaterThanOrEqual(0);
        const summary = summariseSteps(steps);
        expect(formatStepSummary(summary)).toBe('3 steps · 2 commands, 1 read · 1 failed, recovered');
        expect(summary.durationMs).toBeTypeOf('number');
        expect(turnOpensItself(steps)).toBe(false);

        // Push the message out of the chat's window into its pages: the steps come back from there as they were.
        for (let i = 0; i < 320; i++) await chat().post(`note ${i}`);
        const paged = await agentMsgs();
        expect(paged).toHaveLength(1);
        expect(paged[0]!.steps).toEqual(steps);
    });
});

describe('foldTurnSteps (#1055)', () => {
    const base = { sessionId: 'rt', epoch: 1 };
    let seq = 0;
    const ev = (e: Record<string, unknown>, at?: number): AgentEvent => ({ ...base, seq: ++seq, turnId: 't1', ...(at !== undefined ? { at } : {}), ...e }) as unknown as AgentEvent;
    const input = { turnId: 't1', agentId: AGENT, sessionId: 'session_9', runtime: 'claude-code' };

    it('attaches coding.diffs to their call, skips a sub-agent’s calls and other turns, and says nothing for a turn without calls', () => {
        const events = [
            ev({ type: 'turn-start', input: [] }, 10),
            ev({ type: 'tool-call', callId: 'c1', name: 'Edit', input: { file_path: '/a.ts', old_string: 'x', new_string: 'y' } }, 11),
            ev({ type: 'tool-update', callId: 'c1', status: 'pending' }, 11),
            ev({ type: 'ext', ns: 'coding', name: 'diff', data: { path: '/a.ts', oldText: 'a\nb', newText: 'a\nc\nd' }, parentCallId: 'c1' }, 12),
            ev({ type: 'tool-update', callId: 'c1', status: 'completed', output: 'ok' }, 13),
            ev({ type: 'tool-call', callId: 'task', name: 'Task', input: { description: 'look around' } }, 14),
            ev({ type: 'tool-call', callId: 'nested', name: 'Bash', input: { command: 'ls' }, parentCallId: 'task' }, 15),
            ev({ type: 'tool-update', callId: 'task', status: 'completed', output: 'done' }, 16),
            { ...ev({ type: 'tool-call', callId: 'other', name: 'Bash', input: { command: 'ls' } }, 17), turnId: 't0' } as AgentEvent,
            ev({ type: 'turn-end', stopReason: 'end_turn' }, 20)
        ];
        const steps = foldTurnSteps(events, input)!;
        expect(steps).toMatchObject({ turnId: 't1', total: 2, startedAt: 10, endedAt: 20 });
        expect(steps.steps.map((s) => [s.id, s.kind, s.target, s.result, s.startedAt, s.endedAt])).toEqual([
            ['c1', 'edit', '/a.ts', '+2 −1', 11, 13],
            ['task', 'other', 'look around', undefined, 14, 16]
        ]);
        expect(foldTurnSteps([ev({ type: 'turn-start', input: [] }), ev({ type: 'turn-end', stopReason: 'end_turn' })], input)).toBeUndefined();
    });

    it('an anthropic-api call takes its target from the activity line; a cancelled call is an error; events without `at` carry no times', () => {
        const steps = foldTurnSteps(
            [
                ev({ type: 'tool-call', callId: 'm1', name: 'memory_search', category: 'search', input: { query: 'tea' } }),
                ev({ type: 'tool-call', callId: 'm2', name: 'write_file', input: { path: '/x/notes.md' } }),
                ev({ type: 'tool-update', callId: 'm2', status: 'cancelled', error: 'interrupted' })
            ],
            { ...input, runtime: 'anthropic-api' }
        )!;
        expect(steps.steps.map((s) => [s.kind, s.target, s.state])).toEqual([
            ['search', 'Using memory_search', 'pending'],
            ['other', 'Editing notes.md', 'error']
        ]);
        expect(steps.steps[1]!.output).toMatchObject({ excerpt: ['interrupted'], ref: 'session_9#m2' });
        expect(steps.steps[0]!.startedAt).toBeUndefined();
        expect(steps.startedAt).toBeUndefined();
    });

    it('caps a long turn, keeps `total` true, and one turn’s summary stays within a few KB even when every step fails loudly (the last failures keep an excerpt)', () => {
        const noisy = Array.from({ length: 200 }, (_, i) => `Error: line ${i} ${'y'.repeat(400)}`).join('\n');
        const events: AgentEvent[] = [];
        for (let i = 0; i < 150; i++) {
            events.push(ev({ type: 'tool-call', callId: `toolu_01${String(i).padStart(22, '0')}`, name: 'Bash', input: { command: `pnpm --filter @agentic/web test -- ${'z'.repeat(300)} ${i}` } }, 100 + i));
            events.push(ev({ type: 'tool-update', callId: `toolu_01${String(i).padStart(22, '0')}`, status: 'failed', error: `Exit code 2\n${noisy}` }, 101 + i));
        }
        const steps = foldTurnSteps(events, input)!;
        expect(steps.steps).toHaveLength(TURN_STEPS_CAP);
        expect(steps.total).toBe(150);
        const bytes = new TextEncoder().encode(JSON.stringify(steps)).length;
        // The worst case: every step failed, with the longest target and a full excerpt of the longest lines.
        expect(bytes).toBeLessThan(32 * 1024);
        expect(steps.steps.filter((s) => s.output)).toHaveLength(TURN_EXCERPTS_MAX);
        expect(steps.steps.at(-1)!.output).toBeDefined();
        // A typical turn: short commands, one failure.
        const typical = foldTurnSteps(
            [
                ev({ type: 'tool-call', callId: 'toolu_01a', name: 'Bash', input: { command: 'pnpm test' } }, 1),
                ev({ type: 'tool-update', callId: 'toolu_01a', status: 'failed', error: FAILED_OUTPUT }, 2),
                ...Array.from({ length: 30 }, (_, i) => [
                    ev({ type: 'tool-call', callId: `toolu_r${i}`, name: 'Read', input: { file_path: `/work/src/module-${i}.ts` } }, 3 + i),
                    ev({ type: 'tool-update', callId: `toolu_r${i}`, status: 'completed', output: 'x'.repeat(5000) }, 4 + i)
                ]).flat()
            ],
            input
        )!;
        expect(new TextEncoder().encode(JSON.stringify(typical)).length).toBeLessThan(8 * 1024);
    });
});
