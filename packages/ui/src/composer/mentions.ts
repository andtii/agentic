/**
 * The `@mention` popup's model, as pure functions: where the token under the
 * caret is, which entries match it, and what the draft becomes once one is
 * picked. Nothing here touches the DOM, so the rules are unit-testable and
 * the component is only wiring.
 */

export interface Mention {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
}

export interface MentionQuery {
    /** Index of the `@`. */
    readonly start: number;
    /** The caret — end of the token (exclusive). */
    readonly end: number;
    /** The text after the `@`. */
    readonly query: string;
}

export const MAX_MENTIONS = 8;

/**
 * The mention token the caret is in, if any: an `@` at the start of the text
 * or after whitespace, followed by non-whitespace up to the caret. Once a
 * space is typed the token is over and the popup closes.
 */
export function mentionAt(text: string, caret: number): MentionQuery | undefined {
    const upTo = text.slice(0, caret);
    const at = upTo.lastIndexOf('@');
    if (at === -1) return undefined;
    if (at > 0 && !/\s/.test(upTo.charAt(at - 1))) return undefined;
    const query = upTo.slice(at + 1);
    if (/\s/.test(query)) return undefined;
    return { start: at, end: caret, query };
}

/** Case-insensitive prefix matches first, then substring matches, capped. */
export function filterMentions(all: readonly Mention[], query: string, max = MAX_MENTIONS): Mention[] {
    const q = query.toLowerCase();
    const starts: Mention[] = [];
    const contains: Mention[] = [];
    for (const m of all) {
        const label = m.label.toLowerCase();
        const id = m.id.toLowerCase();
        if (label.startsWith(q) || id.startsWith(q)) starts.push(m);
        else if (label.includes(q) || id.includes(q)) contains.push(m);
    }
    return [...starts, ...contains].slice(0, max);
}

/** The draft with the token replaced by `@label ` and the caret after it. */
export function insertMention(text: string, q: MentionQuery, m: Mention): { text: string; caret: number } {
    const inserted = `@${m.label} `;
    const next = text.slice(0, q.start) + inserted + text.slice(q.end);
    return { text: next, caret: q.start + inserted.length };
}

/** Autogrow by line count — deterministic, no layout read. */
export function rowsFor(text: string, min: number, max: number): number {
    const lines = text.split('\n').length;
    return Math.min(max, Math.max(min, lines));
}
