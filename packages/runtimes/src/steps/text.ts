/** Small readers the step normalisers share (#1055): input fields, output text, line counts. */

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The first of `keys` that is a non-blank string on `input`, trimmed. */
export function stringField(input: unknown, ...keys: readonly string[]): string | undefined {
    if (!isRecord(input)) return undefined;
    for (const key of keys) {
        const value = input[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return undefined;
}

/** Whitespace collapsed to one line. */
export function oneLine(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

/**
 * A call's output as text: a string as it is; `{output}` (Codex's command) its text; content blocks their text parts;
 * anything else as JSON. `''` for none.
 */
export function stepOutputText(output: unknown): string {
    if (output === undefined || output === null) return '';
    if (typeof output === 'string') return output;
    if (isRecord(output) && typeof output.output === 'string') return output.output;
    if (Array.isArray(output) && output.every((b) => isRecord(b))) {
        const text = output.map((b) => (typeof b.text === 'string' ? b.text : '')).filter(Boolean);
        if (text.length) return text.join('\n');
    }
    try {
        return JSON.stringify(output) ?? '';
    } catch {
        return '';
    }
}

/** Lines of `text`, a trailing newline not counted; 0 for none. */
export function lineCount(text: string | undefined): number {
    if (!text) return 0;
    const lines = text.split(/\r?\n/);
    if (lines[lines.length - 1] === '') lines.pop();
    return lines.length;
}

/**
 * `+a −b` of replacing `oldText` with `newText`, by lines: the lines both share at the start and at the end are not
 * counted; the rest of the old text is removed and the rest of the new text added.
 */
export function diffCounts(oldText: string | undefined, newText: string | undefined): { added: number; removed: number } {
    const a = oldText ? oldText.split(/\r?\n/) : [];
    const b = newText ? newText.split(/\r?\n/) : [];
    if (a[a.length - 1] === '') a.pop();
    if (b[b.length - 1] === '') b.pop();
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let end = 0;
    while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
    return { removed: a.length - start - end, added: b.length - start - end };
}

export function formatDiff(counts: readonly { added: number; removed: number }[]): string | undefined {
    if (!counts.length) return undefined;
    const added = counts.reduce((n, c) => n + c.added, 0);
    const removed = counts.reduce((n, c) => n + c.removed, 0);
    return `+${added} −${removed}`;
}

/** `N matches`, `1 match`. */
export function matches(n: number): string {
    return `${n} ${n === 1 ? 'match' : 'matches'}`;
}

/** A target any runtime's input may name: a command, a path, a pattern, a query or a URL. */
export function genericTarget(input: unknown): string | undefined {
    const command = isRecord(input) && Array.isArray(input.command) && input.command.every((c) => typeof c === 'string') ? (input.command as string[]).join(' ') : undefined;
    return command || stringField(input, 'command', 'cmd', 'file_path', 'filePath', 'path', 'notebook_path', 'pattern', 'query', 'url', 'description');
}
