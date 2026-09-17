import { describe, it, expect } from 'vitest';
import type { AgentMessage, AgentPart } from '@sigx/ai-agent/app';
import { followRange, frozenRange, unitCount, windowRows } from '../src/thread/window';

const text = (t: string): AgentPart => ({ type: 'text', id: t, text: t });
const msg = (id: string, n: number): AgentMessage => ({ id, role: 'assistant', parts: Array.from({ length: n }, (_, i) => text(`${id}/${i}`)) });

describe('the thread window', () => {
    it('counts one unit per part, and one for an empty message', () => {
        expect(unitCount([msg('a', 3), msg('b', 0), msg('c', 2)])).toBe(6);
    });

    it('follows the tail: the last `size` units, whatever the message shape', () => {
        const messages = [msg('a', 100), msg('b', 100)];
        const rows = windowRows(messages, followRange(unitCount(messages), 30));
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ message: messages[1], from: 70, to: 100, partial: true });
    });

    it('splits a window across messages into one row per message', () => {
        const messages = [msg('a', 5), msg('b', 5), msg('c', 5)];
        const rows = windowRows(messages, { start: 3, end: 12 });
        expect(rows.map((r) => [r.message.id, r.from, r.to, r.partial])).toEqual([
            ['a', 3, 5, true],
            ['b', 0, 5, false],
            ['c', 0, 2, true]
        ]);
    });

    it('never renders more rows than units, and never more parts than the window', () => {
        const messages = Array.from({ length: 40 }, (_, i) => msg(`m${i}`, 50));
        const rows = windowRows(messages, followRange(unitCount(messages), 150));
        expect(rows.length).toBeLessThanOrEqual(150);
        expect(rows.reduce((n, r) => n + (r.to - r.from), 0)).toBe(150);
    });

    it('an empty message is a row of its own with no parts', () => {
        const rows = windowRows([msg('a', 0)], followRange(1, 10));
        expect(rows).toEqual([{ key: 'a', message: { id: 'a', role: 'assistant', parts: [] }, from: 0, to: 0, partial: false }]);
    });

    it('keys a row by its message alone, so a sliding window patches the row instead of remounting it', () => {
        const messages = [msg('a', 100)];
        const before = windowRows(messages, followRange(100, 30));
        messages[0]!.parts.push(text('a/100'));
        const after = windowRows(messages, followRange(101, 30));
        expect(after[0]!.from).not.toBe(before[0]!.from);
        expect(after[0]!.key).toBe(before[0]!.key);
    });

    it('a frozen range keeps its end while the tail grows, and widens backwards on request', () => {
        expect(frozenRange(500, 200, 50)).toEqual({ start: 150, end: 200 });
        expect(frozenRange(500, 200, 50, 100)).toEqual({ start: 50, end: 200 });
        // Clamped to what exists.
        expect(frozenRange(120, 200, 50)).toEqual({ start: 70, end: 120 });
    });
});
