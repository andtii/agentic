/**
 * A line diff for the plain renderer and for callers that need diff facts
 * without an editor (#563): which working lines differ from HEAD (the Files
 * view's change stripes), the unified rows with `@@` hunk headers (the
 * no-JS / test diff), the split pairs, and the hunk around a line (what
 * "Send to chat" attaches). Myers' O(ND) algorithm after trimming the
 * common prefix and suffix; past `MAX_EDITS` edits the middle is reported
 * as one replaced block rather than spending unbounded time on it.
 */

/** One line of either text after diffing; line numbers are 1-based. */
export type DiffOp =
    | { readonly kind: 'equal'; readonly old: number; readonly new: number; readonly text: string }
    | { readonly kind: 'removed'; readonly old: number; readonly text: string }
    | { readonly kind: 'added'; readonly new: number; readonly text: string };

/** A row of the unified diff: a hunk header, or a line with its old and/or new number. */
export type DiffRow =
    | { readonly kind: 'hunk'; readonly text: string }
    | { readonly kind: 'context'; readonly old: number; readonly new: number; readonly text: string }
    | { readonly kind: 'removed'; readonly old: number; readonly text: string }
    | { readonly kind: 'added'; readonly new: number; readonly text: string };

/** A row of the split diff: the left (old) and right (new) cells, either absent on a one-sided change. */
export type SplitRow =
    | { readonly kind: 'hunk'; readonly text: string }
    | {
        readonly kind: 'line';
        readonly left?: { readonly line: number; readonly text: string; readonly change: boolean };
        readonly right?: { readonly line: number; readonly text: string; readonly change: boolean };
    };

/** Which text a line number refers to — the same pair `@sigx/monaco-editor` reports. */
export type DiffSide = 'original' | 'modified';

/** A line of one side of a diff. */
export interface LineRef {
    readonly side: DiffSide;
    readonly line: number;
}

/** Past this many edits the changed middle is one replaced block (bounded time and memory). */
export const MAX_EDITS = 1500;
/** Unchanged lines kept around each change in a unified hunk. */
export const DIFF_CONTEXT = 3;

/** The lines of a text; a final newline does not make an extra empty line. */
export function splitLines(text: string): string[] {
    if (text === '') return [];
    const lines = text.split(/\r?\n/);
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
}

/** The line-by-line diff of two texts (or line arrays). */
export function diffLines(original: string | readonly string[], modified: string | readonly string[]): DiffOp[] {
    const a = typeof original === 'string' ? splitLines(original) : original;
    const b = typeof modified === 'string' ? splitLines(modified) : modified;
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA--;
        endB--;
    }
    const ops: DiffOp[] = [];
    for (let i = 0; i < start; i++) ops.push({ kind: 'equal', old: i + 1, new: i + 1, text: a[i]! });
    ops.push(...middle(a, b, start, endA, endB));
    for (let i = 0; i < a.length - endA; i++) ops.push({ kind: 'equal', old: endA + i + 1, new: endB + i + 1, text: a[endA + i]! });
    return ops;
}

/** Myers over `a[start, endA)` against `b[start, endB)`: removals before additions inside a changed run. */
function middle(a: readonly string[], b: readonly string[], start: number, endA: number, endB: number): DiffOp[] {
    const n = endA - start;
    const m = endB - start;
    const replaced = (): DiffOp[] => [
        ...Array.from({ length: n }, (_, i): DiffOp => ({ kind: 'removed', old: start + i + 1, text: a[start + i]! })),
        ...Array.from({ length: m }, (_, i): DiffOp => ({ kind: 'added', new: start + i + 1, text: b[start + i]! }))
    ];
    if (n === 0 || m === 0) return replaced();
    const max = Math.min(n + m, MAX_EDITS);
    const offset = max + 1;
    const v = new Int32Array(2 * max + 3);
    // trace[d] holds v[-d..d] as it was before step d, for the backtrack.
    const trace: Int32Array[] = [];
    let found = -1;
    for (let d = 0; d <= max && found < 0; d++) {
        trace.push(v.slice(offset - d, offset + d + 1));
        for (let k = -d; k <= d; k += 2) {
            let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
            let y = x - k;
            while (x < n && y < m && a[start + x] === b[start + y]) {
                x++;
                y++;
            }
            v[offset + k] = x;
            if (x >= n && y >= m) {
                found = d;
                break;
            }
        }
    }
    if (found < 0) return replaced();
    // Walk back from (n, m), one edit per step, collecting the diagonal (equal) runs between them.
    const out: DiffOp[] = [];
    let x = n;
    let y = m;
    for (let d = found; d > 0; d--) {
        const prev = trace[d]!;
        const at = (k: number): number => prev[k + d]!;
        const k = x - y;
        const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
        const prevK = down ? k + 1 : k - 1;
        const prevX = at(prevK);
        const prevY = prevX - prevK;
        while (x > prevX + (down ? 0 : 1) && y > prevY + (down ? 1 : 0)) {
            x--;
            y--;
            out.push({ kind: 'equal', old: start + x + 1, new: start + y + 1, text: a[start + x]! });
        }
        if (down) {
            y--;
            out.push({ kind: 'added', new: start + y + 1, text: b[start + y]! });
        } else {
            x--;
            out.push({ kind: 'removed', old: start + x + 1, text: a[start + x]! });
        }
    }
    while (x > 0 && y > 0) {
        x--;
        y--;
        out.push({ kind: 'equal', old: start + x + 1, new: start + y + 1, text: a[start + x]! });
    }
    out.reverse();
    return orderRuns(out);
}

/** Inside each run of changes, removals first — the order a unified diff reads in. */
function orderRuns(ops: DiffOp[]): DiffOp[] {
    const out: DiffOp[] = [];
    let removed: DiffOp[] = [];
    let added: DiffOp[] = [];
    const flush = (): void => {
        out.push(...removed, ...added);
        removed = [];
        added = [];
    };
    for (const op of ops) {
        if (op.kind === 'removed') removed.push(op);
        else if (op.kind === 'added') added.push(op);
        else {
            flush();
            out.push(op);
        }
    }
    flush();
    return out;
}

/** The new-side lines that are added or changed — the Files view's change stripes. */
export function changedLines(original: string, modified: string): number[] {
    return diffLines(original, modified).flatMap((op) => (op.kind === 'added' ? [op.new] : []));
}

/** [start, end) index ranges of `ops` per hunk: each change with `context` equal lines around it, overlaps merged. */
function hunkRanges(ops: readonly DiffOp[], context: number): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    ops.forEach((op, i) => {
        if (op.kind === 'equal') return;
        const from = Math.max(0, i - context);
        const to = Math.min(ops.length, i + context + 1);
        const last = ranges[ranges.length - 1];
        if (last && from <= last[1]) last[1] = Math.max(last[1], to);
        else ranges.push([from, to]);
    });
    return ranges;
}

/** Git's default hunk label: the nearest line above the hunk that starts in column one, without a trailing `{`. */
function hunkLabel(ops: readonly DiffOp[], before: number): string {
    for (let i = before - 1; i >= 0; i--) {
        const op = ops[i]!;
        if (op.kind === 'added') continue;
        if (/^[^\s]/.test(op.text)) return op.text.replace(/\s*\{\s*$/, '').trim();
    }
    return '';
}

/** The `@@ -a,b +c,d @@ label` header for `ops[from, to)`. */
function hunkHeader(ops: readonly DiffOp[], from: number, to: number): string {
    const slice = ops.slice(from, to);
    const olds = slice.filter((op) => op.kind !== 'added').length;
    const news = slice.filter((op) => op.kind !== 'removed').length;
    const firstOld = slice.find((op) => op.kind !== 'added') as { old: number } | undefined;
    const firstNew = slice.find((op) => op.kind !== 'removed') as { new: number } | undefined;
    const oldStart = firstOld ? firstOld.old : precedingLine(ops, from, 'old');
    const newStart = firstNew ? firstNew.new : precedingLine(ops, from, 'new');
    const label = hunkLabel(ops, from);
    return `@@ -${oldStart},${olds} +${newStart},${news} @@${label ? ` ${label}` : ''}`;
}

/** For a hunk with no lines on one side: the line before it on that side (git's convention), 0 at the top. */
function precedingLine(ops: readonly DiffOp[], before: number, side: 'old' | 'new'): number {
    for (let i = before - 1; i >= 0; i--) {
        const op = ops[i]! as { old?: number; new?: number };
        const n = side === 'old' ? op.old : op.new;
        if (n !== undefined) return n;
    }
    return 0;
}

const toRow = (op: DiffOp): DiffRow => (op.kind === 'equal' ? { kind: 'context', old: op.old, new: op.new, text: op.text } : op);

/** The unified rows: hunk headers and the lines each hunk keeps. An identical pair gives no rows. */
export function unifiedRows(ops: readonly DiffOp[], context = DIFF_CONTEXT): DiffRow[] {
    return hunkRanges(ops, context).flatMap(([from, to]) => [{ kind: 'hunk', text: hunkHeader(ops, from, to) } as DiffRow, ...ops.slice(from, to).map(toRow)]);
}

/** The split rows: per hunk, context on both sides, each removed run paired line by line with the added run after it. */
export function splitRows(ops: readonly DiffOp[], context = DIFF_CONTEXT): SplitRow[] {
    const rows: SplitRow[] = [];
    for (const [from, to] of hunkRanges(ops, context)) {
        rows.push({ kind: 'hunk', text: hunkHeader(ops, from, to) });
        let i = from;
        while (i < to) {
            const op = ops[i]!;
            if (op.kind === 'equal') {
                rows.push({ kind: 'line', left: { line: op.old, text: op.text, change: false }, right: { line: op.new, text: op.text, change: false } });
                i++;
                continue;
            }
            const removed: Array<Extract<DiffOp, { kind: 'removed' }>> = [];
            const added: Array<Extract<DiffOp, { kind: 'added' }>> = [];
            while (i < to && ops[i]!.kind === 'removed') removed.push(ops[i++] as Extract<DiffOp, { kind: 'removed' }>);
            while (i < to && ops[i]!.kind === 'added') added.push(ops[i++] as Extract<DiffOp, { kind: 'added' }>);
            for (let j = 0; j < Math.max(removed.length, added.length); j++) {
                const l = removed[j];
                const r = added[j];
                rows.push({
                    kind: 'line',
                    left: l ? { line: l.old, text: l.text, change: true } : undefined,
                    right: r ? { line: r.new, text: r.text, change: true } : undefined
                });
            }
        }
    }
    return rows;
}

/** Does this op carry `ref`'s line? */
function carries(op: DiffOp, ref: LineRef): boolean {
    return ref.side === 'original' ? op.kind !== 'added' && op.old === ref.line : op.kind !== 'removed' && op.new === ref.line;
}

/**
 * The unified hunk that contains `ref` — header and lines, `+`/`-`/` ` prefixed —
 * or, for a line outside every change, that line with `context` lines around it.
 * What "Ask about a line" attaches to the message.
 */
export function hunkAt(original: string, modified: string, ref: LineRef, context = DIFF_CONTEXT): string {
    const ops = diffLines(original, modified);
    const at = ops.findIndex((op) => carries(op, ref));
    if (at < 0) return '';
    const range = hunkRanges(ops, context).find(([from, to]) => at >= from && at < to) ?? [Math.max(0, at - context), Math.min(ops.length, at + context + 1)];
    const [from, to] = range;
    const body = ops.slice(from, to).map((op) => `${op.kind === 'added' ? '+' : op.kind === 'removed' ? '-' : ' '}${op.text}`);
    return [hunkHeader(ops, from, to), ...body].join('\n');
}
