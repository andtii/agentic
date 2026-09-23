/**
 * The line diff behind the plain renderer, the Files stripes and the hunk
 * "Ask about a line" attaches (#563).
 */
import { describe, expect, it } from 'vitest';
import { MAX_EDITS, changedLines, diffLines, hunkAt, splitLines, splitRows, unifiedRows, type DiffOp } from '../../src/code/line-diff';

const lines = (n: number, prefix = 'line'): string[] => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);
const text = (xs: readonly string[]): string => `${xs.join('\n')}\n`;

/** Rebuild both sides from the ops — any valid edit script must round-trip. */
function sides(ops: readonly DiffOp[]): { a: string[]; b: string[] } {
    return {
        a: ops.filter((op) => op.kind !== 'added').map((op) => op.text),
        b: ops.filter((op) => op.kind !== 'removed').map((op) => op.text)
    };
}

describe('splitLines', () => {
    it('does not make an empty last line out of a final newline, and reads CRLF', () => {
        expect(splitLines('')).toEqual([]);
        expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
        expect(splitLines('a\r\nb')).toEqual(['a', 'b']);
        expect(splitLines('a\n\n')).toEqual(['a', '']);
    });
});

describe('diffLines', () => {
    it('reports an identical pair as all equal, with both line numbers', () => {
        const ops = diffLines('a\nb\n', 'a\nb\n');
        expect(ops).toEqual([
            { kind: 'equal', old: 1, new: 1, text: 'a' },
            { kind: 'equal', old: 2, new: 2, text: 'b' }
        ]);
    });

    it('finds a changed line in the middle, removal before addition', () => {
        const ops = diffLines('a\nb\nc\n', 'a\nB\nc\n');
        expect(ops.map((op) => op.kind)).toEqual(['equal', 'removed', 'added', 'equal']);
        expect(ops[1]).toEqual({ kind: 'removed', old: 2, text: 'b' });
        expect(ops[2]).toEqual({ kind: 'added', new: 2, text: 'B' });
    });

    it('produces a minimal script that round-trips on interleaved edits', () => {
        const a = ['x', 'a', 'b', 'c', 'd', 'e', 'f'];
        const b = ['a', 'b', 'y', 'd', 'z', 'f', 'g'];
        const ops = diffLines(a, b);
        expect(sides(ops)).toEqual({ a, b });
        // x removed, c→y, e→z, g added: 4 equal lines kept (a b d f).
        expect(ops.filter((op) => op.kind === 'equal').map((op) => op.text)).toEqual(['a', 'b', 'd', 'f']);
        // Line numbers count their own side.
        const added = ops.filter((op) => op.kind === 'added') as Array<Extract<DiffOp, { kind: 'added' }>>;
        expect(added.map((op) => op.new)).toEqual([3, 5, 7]);
    });

    it('handles pure insertions and deletions at either end', () => {
        expect(diffLines('', 'a\nb\n').map((op) => op.kind)).toEqual(['added', 'added']);
        expect(diffLines('a\nb\n', '').map((op) => op.kind)).toEqual(['removed', 'removed']);
        expect(sides(diffLines(['m'], ['h', 'm', 't']))).toEqual({ a: ['m'], b: ['h', 'm', 't'] });
    });

    it('reports a huge unrelated middle as one replaced block instead of searching forever', () => {
        const a = lines(MAX_EDITS + 10, 'old');
        const b = lines(MAX_EDITS + 10, 'new');
        const ops = diffLines(a, b);
        expect(sides(ops)).toEqual({ a, b });
        expect(ops.slice(0, a.length).every((op) => op.kind === 'removed')).toBe(true);
    });
});

describe('unifiedRows', () => {
    it('keeps three lines of context and heads each hunk with @@ counts and git\'s label', () => {
        const a = ['.shell {', ...lines(10, '  x'), '}'];
        const b = [...a];
        b[6] = '  changed';
        const rows = unifiedRows(diffLines(a, b));
        expect(rows[0]).toEqual({ kind: 'hunk', text: '@@ -4,7 +4,7 @@ .shell' });
        expect(rows.filter((r) => r.kind === 'context')).toHaveLength(6);
        expect(rows.filter((r) => r.kind !== 'hunk').map((r) => r.kind)).toEqual(['context', 'context', 'context', 'removed', 'added', 'context', 'context', 'context']);
    });

    it('splits far-apart changes into two hunks and merges close ones', () => {
        const a = lines(40);
        const far = [...a];
        far[2] = 'x';
        far[30] = 'y';
        expect(unifiedRows(diffLines(a, far)).filter((r) => r.kind === 'hunk')).toHaveLength(2);
        const near = [...a];
        near[10] = 'x';
        near[14] = 'y';
        expect(unifiedRows(diffLines(a, near)).filter((r) => r.kind === 'hunk')).toHaveLength(1);
    });

    it('gives no rows for identical texts', () => {
        expect(unifiedRows(diffLines('a\n', 'a\n'))).toEqual([]);
    });
});

describe('splitRows', () => {
    it('pairs a removed run with the added run after it, line by line', () => {
        const rows = splitRows(diffLines('a\nb\nc\nz\n', 'a\nB\nz\n'));
        const lineRows = rows.filter((r) => r.kind === 'line');
        expect(lineRows[1]).toEqual({ kind: 'line', left: { line: 2, text: 'b', change: true }, right: { line: 2, text: 'B', change: true } });
        expect(lineRows[2]).toEqual({ kind: 'line', left: { line: 3, text: 'c', change: true }, right: undefined });
    });
});

describe('changedLines', () => {
    it('lists the working lines added or changed since HEAD — the Files stripes', () => {
        expect(changedLines('a\nb\nc\n', 'a\nB\nc\nd\n')).toEqual([2, 4]);
        expect(changedLines('a\n', 'a\n')).toEqual([]);
    });
});

describe('hunkAt', () => {
    it('returns the unified hunk carrying a line of either side (no label: nothing above line 1)', () => {
        const a = ['.drawer {', '  width: 232px;', '  display: flex;', '}'];
        const b = ['.drawer {', '  width: var(--drawer-w);', '  display: flex;', '}'];
        const hunk = hunkAt(text(a), text(b), { side: 'original', line: 2 });
        expect(hunk.split('\n')).toEqual(['@@ -1,4 +1,4 @@', ' .drawer {', '-  width: 232px;', '+  width: var(--drawer-w);', '   display: flex;', ' }']);
        expect(hunkAt(text(a), text(b), { side: 'modified', line: 2 })).toBe(hunk);
    });

    it('gives an unchanged line its surrounding context, and nothing for a line that is not there', () => {
        const a = lines(20);
        const hunk = hunkAt(text(a), text(a), { side: 'modified', line: 10 });
        expect(hunk.split('\n')).toHaveLength(8);
        expect(hunkAt(text(a), text(a), { side: 'modified', line: 99 })).toBe('');
    });
});
