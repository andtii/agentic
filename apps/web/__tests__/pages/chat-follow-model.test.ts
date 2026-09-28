/**
 * The Follow panel's live output (#1060): the tail of the session's `coding.terminal` output when the feed
 * folds coding events, else its turn's newest tool output — a running call's partial output first.
 */
import { describe, expect, it } from 'vitest';
import { createTranscript } from '@sigx/ai-agent';
import type { AgentTranscript, ToolPartState } from '@sigx/ai-agent/app';
import { codingStateOf } from '@sigx/ai-agent/coding';
import { liveOutput, toolOutputText } from '../../src/pages/chat/follow/model';

const tool = (callId: string, status: ToolPartState['status'], output?: unknown): ToolPartState => ({ type: 'tool', callId, name: 'Bash', status, ...(output !== undefined ? { output } : {}) });

function running(parts: ToolPartState[]): AgentTranscript {
    const t = createTranscript('s1');
    t.turn = { turnId: 'tu1' };
    t.state = 'running';
    t.messages.push({ id: 'u1', role: 'user', turnId: 'tu1', parts: [{ type: 'text', text: 'go' }] }, { id: 'a1', role: 'assistant', turnId: 'tu1', parts });
    return t;
}

describe('liveOutput', () => {
    it('reads the newest terminal, trailing newline dropped', () => {
        const t = running([tool('c1', 'completed', 'from the tool')]);
        const coding = codingStateOf(t);
        coding.terminals['term1'] = { output: 'old terminal\n', truncated: false };
        coding.terminals['term2'] = { output: 'line 1\r\nline 2\nline 3\n', truncated: false };
        expect(liveOutput(t)).toEqual(['line 1', 'line 2', 'line 3']);
    });

    it('without terminal output, a running call with output wins over a newer finished one', () => {
        expect(liveOutput(running([tool('c1', 'in_progress', 'partial 1\npartial 2'), tool('c2', 'completed', 'done')]))).toEqual(['partial 1', 'partial 2']);
    });

    it('else the newest call with output; nothing when no call has any', () => {
        expect(liveOutput(running([tool('c1', 'completed', 'first'), tool('c2', 'completed', 'second'), tool('c3', 'in_progress')]))).toEqual(['second']);
        expect(liveOutput(running([tool('c1', 'in_progress')]))).toEqual([]);
        expect(liveOutput(createTranscript('s2'))).toEqual([]);
    });

    it('keeps the last 40 lines', () => {
        const long = Array.from({ length: 100 }, (_, i) => `l${i}`).join('\n');
        const out = liveOutput(running([tool('c1', 'in_progress', long)]));
        expect(out).toHaveLength(40);
        expect(out[39]).toBe('l99');
    });
});

describe('toolOutputText', () => {
    it('a string as is, text blocks joined, anything else as JSON', () => {
        expect(toolOutputText(tool('c', 'completed', 'x'))).toBe('x');
        expect(toolOutputText({ ...tool('c', 'completed'), content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toBe('a\nb');
        expect(toolOutputText(tool('c', 'completed', { ok: true }))).toBe('{\n  "ok": true\n}');
        expect(toolOutputText(tool('c', 'completed'))).toBeUndefined();
    });
});
