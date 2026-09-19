/**
 * `platformA2aSession` (#245): one A2A context over platform tasks, against a
 * fake port. The mounted server end to end — OAuth, the plugin gate, the
 * router — is AC-14 (`acceptance/ac-14.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import type { AgentId, SessionId, TaskId, TaskStatus } from '@agentic/core';
import type { CreateTaskInput, PlatformPort, RespondDecision, TaskSummary } from '@agentic/mcp';
import { SessionBusyError, type AgentEvent } from '@sigx/ai-agent';
import { platformA2aSession } from '../src/a2a/session';

const AGENT = 'agent_helper' as AgentId;
const SESSION = 'session_1' as SessionId;

const summary = (taskId: string, status: TaskStatus, extra: Partial<TaskSummary> = {}): TaskSummary => ({ taskId: taskId as TaskId, status, assignee: AGENT, owner: AGENT, objective: 'x', children: [], ...extra });

const ev = (seq: number, e: Record<string, unknown>): AgentEvent => ({ sessionId: SESSION, epoch: 1, seq, ...e }) as unknown as AgentEvent;

/** A port whose one task opens `SESSION` and whose log is `log` — events released as the test pushes them. */
function fakePlatform(options: { log?: AgentEvent[]; task?: (n: number) => TaskSummary } = {}) {
    const log = options.log ?? [];
    const created: CreateTaskInput[] = [];
    const cancelled: TaskId[] = [];
    const answered: { requestId: string; decision: RespondDecision }[] = [];
    let n = 0;
    const task = options.task ?? ((i: number) => summary(`task_${i}`, 'active', { sessionId: SESSION }));
    const platform: Pick<PlatformPort, 'tasks' | 'sessions'> = {
        tasks: {
            create: async (input) => {
                created.push(input);
                return task(++n);
            },
            get: async () => task(n),
            cancel: async (taskId) => {
                cancelled.push(taskId);
                return { taskId, stopped: true, notStopped: [] };
            },
            delegate: async () => {
                throw new Error('unused');
            },
            tree: async () => {
                throw new Error('unused');
            }
        },
        sessions: {
            tail: async (sessionId, from) => {
                const events = log.filter((e) => !from || e.seq > from.seq);
                const last = events.at(-1);
                return { sessionId, status: 'running', events, next: last ? { epoch: last.epoch, seq: last.seq } : (from ?? { epoch: 0, seq: 0 }), truncated: false };
            },
            respond: async (_s, requestId, decision) => {
                answered.push({ requestId, decision });
                return { commandId: 'c', kind: 'ack' };
            },
            open: async () => {
                throw new Error('unused');
            },
            prompt: async () => {
                throw new Error('unused');
            },
            cancel: async () => {
                throw new Error('unused');
            }
        }
    };
    return { platform, log, created, cancelled, answered };
}

const collect = async (turn: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> => {
    const out: AgentEvent[] = [];
    for await (const e of turn) out.push(e);
    return out;
};
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('platformA2aSession', () => {
    it("yields the task's own turn — the first to start in its session — and ends at its turn-end", async () => {
        const f = fakePlatform({
            log: [
                ev(1, { type: 'session-state', state: 'idle' }),
                ev(2, { type: 'turn-start', turnId: 't1', input: [] }),
                ev(3, { type: 'part-delta', turnId: 't1', partId: 'p', delta: 'hello' }),
                ev(4, { type: 'part-delta', turnId: 't1', partId: 'q', delta: 'nested', parentCallId: 'c1' }),
                ev(5, { type: 'turn-end', turnId: 't1', stopReason: 'end_turn' }),
                ev(6, { type: 'turn-start', turnId: 't2', input: [] })
            ]
        });
        const s = platformA2aSession({ platform: f.platform, agentId: AGENT, contextId: 'ctx', pollMs: 0 });
        const turn = s.prompt('Hi there', { turnId: 'a2a-task' });
        const events = await collect(turn);
        expect(events.map((e) => e.type)).toEqual(['turn-start', 'part-delta', 'part-delta', 'turn-end']);
        expect(await turn.result).toMatchObject({ turnId: 'a2a-task', stopReason: 'end_turn' });
        expect(f.created[0]).toMatchObject({ agentId: AGENT, objective: 'Hi there', context: [] });

        // The next task of the context carries the exchange — the sub-agent's text is not the answer.
        await collect(s.prompt('Again'));
        const context = f.created[1]!.context![0] as { text: string };
        expect(context.text).toContain('Client: Hi there\nYou: hello');
        expect(context.text).not.toContain('nested');
    });

    it('a task that fails before any session opens is a turn that ends in error, naming the platform code', async () => {
        const f = fakePlatform({ task: (i) => summary(`task_${i}`, 'failed', { error: { code: 'plugin-disabled', message: 'the anthropic-api plugin is turned off' } }) });
        const s = platformA2aSession({ platform: f.platform, agentId: AGENT, contextId: 'ctx', pollMs: 0 });
        const events = await collect(s.prompt('Hi'));
        expect(events.map((e) => e.type)).toEqual(['turn-start', 'turn-end']);
        expect(events[1]).toMatchObject({ stopReason: 'error', error: { message: 'plugin-disabled: the anthropic-api plugin is turned off' } });
    });

    it('a task that ends with no turn-end in its log ends the turn from the task', async () => {
        let status: TaskStatus = 'active';
        const f = fakePlatform({ log: [ev(1, { type: 'turn-start', turnId: 't1', input: [] })], task: (i) => summary(`task_${i}`, status, { sessionId: SESSION }) });
        const s = platformA2aSession({ platform: f.platform, agentId: AGENT, contextId: 'ctx', pollMs: 0 });
        const turn = collect(s.prompt('Hi'));
        await tick();
        status = 'cancelled';
        const events = await turn;
        expect(events.map((e) => e.type)).toEqual(['turn-start', 'turn-end']);
        expect(events[1]).toMatchObject({ stopReason: 'cancelled' });
    });

    it('refuses a second message while a turn runs, answers requests on the session, and cancels the task', async () => {
        const f = fakePlatform({ log: [ev(1, { type: 'turn-start', turnId: 't1', input: [] }), ev(2, { type: 'request', turnId: 't1', requestId: 'r1', kind: 'input' })] });
        const s = platformA2aSession({ platform: f.platform, agentId: AGENT, contextId: 'ctx', pollMs: 1 });
        const running = s.prompt('Hi')[Symbol.asyncIterator]();
        expect((await running.next()).value).toMatchObject({ type: 'turn-start' });
        await expect(collect(s.prompt('Also'))).rejects.toBeInstanceOf(SessionBusyError);

        await s.respond('r1', { type: 'input', answers: { city: 'Oslo' } });
        expect(f.answered).toEqual([{ requestId: 'r1', decision: { type: 'input', answers: { city: 'Oslo' } } }]);

        await s.cancel();
        expect(f.cancelled).toEqual(['task_1']);
        await running.return?.(undefined);
    });

    it('a message without text never becomes a task', async () => {
        const f = fakePlatform();
        const s = platformA2aSession({ platform: f.platform, agentId: AGENT, contextId: 'ctx', pollMs: 0 });
        const turn = s.prompt([{ type: 'image', data: 'AAAA', mediaType: 'image/png' }] as never);
        await expect(collect(turn)).rejects.toThrow(/no text/);
        await expect(turn.result).rejects.toThrow(/no text/);
        expect(f.created).toEqual([]);
    });
});
