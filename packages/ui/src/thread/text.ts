/**
 * Text helpers for the cards. One rule runs through all of them: an element
 * is for content that EXISTS, never for content that is merely present — a
 * tool that returned an empty string gets no `<pre>`, a blank error no line.
 */
import { toolOutput } from '@sigx/ai-agent';
import type { ToolPartState } from '@sigx/ai-agent/app';

/** What a card header shows before it elides — a header summarises, the `<details>` has the rest. */
export const HEAD_CHARS = 72;
/** Characters past which an output keeps only its head and tail; lines are the card's business (`OUTPUT_FOLD`, `OUTPUT_LOG`). */
export const OUTPUT_CHARS = 40_000;

/** Text worth putting in an element — `undefined` for anything that would render blank. */
export function nonBlank(text: string | undefined): string | undefined {
    return text !== undefined && text.trim() !== '' ? text : undefined;
}

/** `1536` → `1.5 kB`: SI units, one decimal below 10, none above — zero's `formatBytes` rule, without pulling in its file-upload module. */
export function formatBytes(size: number): string {
    if (size < 1000) return `${size} B`;
    const units = ['kB', 'MB', 'GB', 'TB'];
    let value = size / 1000;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) {
        value /= 1000;
        unit++;
    }
    return `${value < 10 ? Number(value.toFixed(1)) : Math.round(value)} ${units[unit]}`;
}

/** One line, whitespace collapsed, capped. */
export function oneLine(text: string, max = HEAD_CHARS): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The call signature for the header: the FIRST argument, summarised —
 * `Bash(command: ls -la)`, not forty lines of nested JSON.
 */
export function signature(input: unknown): string {
    if (input === undefined || input === null) return '';
    if (typeof input !== 'object') return oneLine(String(input));
    const entries = Object.entries(input as Record<string, unknown>);
    if (entries.length === 0) return '';
    const [name, value] = entries[0]!;
    const shown = oneLine(`${name}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
    return entries.length > 1 ? `${shown}, +${entries.length - 1}` : shown;
}

/** Keep the head AND the tail of an output too long to hold as text: a listing is worth reading at both ends. */
export function elide(text: string): string {
    let out = text;
    if (out.length > OUTPUT_CHARS) {
        const half = Math.floor(OUTPUT_CHARS / 2);
        out = `${out.slice(0, half)}\n… ${out.length - OUTPUT_CHARS} characters omitted …\n${out.slice(out.length - half)}`;
    }
    return out;
}

/** Did the tool report a result at all? Absent (still running, or a harness that reports none) is not the same as empty. */
export function reportedOutput(p: ToolPartState): boolean {
    return p.output !== undefined || !!p.content?.length;
}

/**
 * The output block as TEXT — a string as is (never `JSON.stringify`, which
 * turns a listing into one quoted line of escapes), anything else
 * pretty-printed JSON; `undefined` when there is nothing to put in a `<pre>`.
 */
export function outputText(p: ToolPartState): string | undefined {
    if (!reportedOutput(p)) return undefined;
    const out = toolOutput(p);
    return nonBlank(elide(typeof out === 'string' ? out : JSON.stringify(out, null, 2)));
}

/** Pretty JSON for the input block. */
export function inputText(input: unknown): string {
    return typeof input === 'string' ? input : JSON.stringify(input, null, 2);
}

/** One or two initials for an avatar slot. */
export function initials(name: string): string {
    const words = name.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return '?';
    const first = words[0]!.charAt(0);
    const last = words.length > 1 ? words[words.length - 1]!.charAt(0) : '';
    return (first + last).toUpperCase();
}
