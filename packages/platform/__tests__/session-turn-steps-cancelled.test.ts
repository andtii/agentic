/**
 * A cancelled call folds to a skipped step (#1097; CHT-09): `foldTurnSteps` maps the `ToolStatus` `'cancelled'` to
 * `'denied'` — as the UI's live `stepState` does — with no failure excerpt, so a call cancelled by Stop does not flip
 * to failed once the turn is saved, and the steps box does not open itself as if a failure had stopped the work.
 */
import { turnOpensItself, type AgentId } from '@agentic/core';
import type { AgentEvent } from '@sigx/ai-agent';

import { foldTurnSteps } from '../src/session/index';

const AGENT = 'agent_ada' as AgentId;
const base = { sessionId: 'rt', epoch: 1 };
let seq = 0;
const ev = (e: Record<string, unknown>, at?: number): AgentEvent => ({ ...base, seq: ++seq, turnId: 't1', ...(at !== undefined ? { at } : {}), ...e }) as unknown as AgentEvent;
const input = { turnId: 't1', agentId: AGENT, sessionId: 'session_9', runtime: 'claude-code' };

describe('foldTurnSteps — a cancelled call (#1097)', () => {
    it('folds to a denied step with no excerpt, and the turn does not open itself', () => {
        const steps = foldTurnSteps(
            [
                ev({ type: 'turn-start', input: [] }, 10),
                ev({ type: 'tool-call', callId: 'c1', name: 'Read', category: 'read', input: { file_path: '/work/a.ts' } }, 11),
                ev({ type: 'tool-update', callId: 'c1', status: 'completed', output: 'x' }, 12),
                ev({ type: 'tool-call', callId: 'c2', name: 'Bash', category: 'execute', input: { command: 'pnpm test' } }, 13),
                ev({ type: 'tool-update', callId: 'c2', status: 'cancelled', output: 'Exit code 130\nInterrupted', error: 'cancelled by the user' }, 14),
                ev({ type: 'turn-end', stopReason: 'cancelled' }, 15)
            ],
            input
        )!;
        expect(steps.steps.map((s) => s.state)).toEqual(['done', 'denied']);
        const cancelled = steps.steps[1]!;
        expect(cancelled.output).toBeUndefined();
        expect(cancelled.endedAt).toBe(14);
        expect(turnOpensItself(steps)).toBe(false);
    });
});
