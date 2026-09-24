/**
 * Who the `@mention` popup lists for a query, as a pure function. zero's
 * `Combobox` in trigger mode owns the token at the caret, the popup, the keys
 * and the insert; the composer hands it this ranked, capped list (with
 * `filter={false}`), so the ranking stays unit-testable.
 */

export interface Mention {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
}

export const MAX_MENTIONS = 8;

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
