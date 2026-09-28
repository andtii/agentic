/**
 * A running step's time ticks (#1088): without a `now` prop the steps box keeps a clock that
 * advances once a second while a step runs, and clears it once none runs or the box unmounts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { signal } from '@sigx/reactivity';
import { component } from '@sigx/runtime-core';
import type { AgentId, TranscriptStep, TurnSteps } from '@agentic/core';
import { Steps } from '../src/transcript';
import { mount, all, unmountAll } from './helpers';

const step = (p: Partial<TranscriptStep> & Pick<TranscriptStep, 'id'>): TranscriptStep => ({
    turnId: 't1',
    agentId: 'claude' as AgentId,
    kind: 'command',
    tool: 'Bash',
    target: 'pnpm check',
    state: 'done',
    ...p
});
const turn = (steps: TranscriptStep[]): TurnSteps => ({ turnId: 't1', steps, total: steps.length });
const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
};
const durations = (root: ParentNode): string[] => all(root, 'ai-steps', 'duration').map((d) => d.textContent ?? '');

afterEach(() => {
    unmountAll();
    vi.useRealTimers();
});

describe('Steps clock', () => {
    it('advances a running step\'s duration once a second, then clears the timer when it is done', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
        vi.setSystemTime(10_000);
        const state = signal({ steps: turn([step({ id: 's1', state: 'running', startedAt: 8_000 })]) });
        const Host = component(() => () => <Steps steps={state.steps} open />);
        const dom = mount(<Host />);
        await flush();
        expect(durations(dom)).toEqual(['2s']);
        expect(vi.getTimerCount()).toBe(1);

        vi.advanceTimersByTime(1000);
        await flush();
        expect(durations(dom)).toEqual(['3s']);
        vi.advanceTimersByTime(2000);
        await flush();
        expect(durations(dom)).toEqual(['5s']);

        state.steps = turn([step({ id: 's1', state: 'done', startedAt: 8_000, endedAt: 13_500 })]);
        await flush();
        expect(durations(dom)).toEqual(['5.5s']);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('clears the timer when the box unmounts mid-step', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
        mount(<Steps steps={turn([step({ id: 's1', state: 'running', startedAt: Date.now() })])} open />);
        await flush();
        expect(vi.getTimerCount()).toBe(1);
        unmountAll();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps no timer with a given now, nor when nothing runs', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
        const dom = mount(<Steps steps={turn([step({ id: 's1', state: 'running', startedAt: 1000 })])} open now={5000} />);
        mount(<Steps steps={turn([step({ id: 's2', startedAt: 0, endedAt: 100 })])} open />);
        await flush();
        expect(vi.getTimerCount()).toBe(0);
        vi.advanceTimersByTime(3000);
        await flush();
        expect(durations(dom)).toEqual(['4s']);
    });
});
