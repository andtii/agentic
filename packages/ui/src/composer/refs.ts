/**
 * What the composer's popup lists for the token at the caret (#940), as pure functions: `@` lists who can be
 * mentioned, and each ref source the host hands in lists its refs under its prefix — `#` a project's plan items,
 * `pr:` its pull requests (each enabled feature's `ui.chatRefPrefixes`). A picked ref goes in as its text form
 * (`#9`, `pr:604`), the one `parseRefs` reads.
 *
 * zero's `Combobox` reads its trigger once, at setup, while the sources arrive later: the trigger is one pattern for
 * any `@…`, `#…` or `word:…` token starting a word, and a token no source claims lists nothing, so no popup opens.
 */
import { filterMentions, MAX_MENTIONS, type Mention } from './mentions.js';

/** One ref a source offers: `id` is what follows the prefix (`9`, `604`), `label` its title. */
export interface RefSuggestion {
    readonly id: string;
    readonly label: string;
}

/** The refs one prefix offers — `{ prefix: '#', items: [{ id: '9', label: 'Fix batch()' }] }`. */
export interface RefSource {
    readonly prefix: string;
    readonly items: readonly RefSuggestion[];
}

/** One row of the popup: `label` is what it shows, `insert` the text that replaces the token. */
export interface ComposerSuggestion {
    readonly key: string;
    readonly label: string;
    readonly insert: string;
}

/**
 * The popup's trigger: a token at the start of a word (the start of the text or after whitespace) that begins with
 * `@`, `#` or a `word:` prefix, up to the caret. Its first group — the whole token, trigger included — is the query.
 */
export const SUGGEST_TRIGGER = /(?<!\S)([@#]\S*|[A-Za-z][\w-]*:\S*)/;

/** The source whose prefix starts `token`, the longest when several do. */
function sourceOf(token: string, sources: readonly RefSource[]): RefSource | undefined {
    let best: RefSource | undefined;
    for (const s of sources) {
        if (s.prefix && token.startsWith(s.prefix) && (!best || s.prefix.length > best.prefix.length)) best = s;
    }
    return best;
}

/**
 * The popup's rows for `token` (the trigger included — `@no`, `#9`, `pr:6`): a ref source's refs when its prefix
 * starts the token, else the mentions for an `@` token, else none. Prefix matches first, capped (`filterMentions`).
 */
export function suggestionsFor(token: string, mentions: readonly Mention[], sources: readonly RefSource[], max = MAX_MENTIONS): ComposerSuggestion[] {
    const source = sourceOf(token, sources);
    if (source) {
        const query = token.slice(source.prefix.length);
        return filterMentions(source.items, query, max).map((r) => {
            const text = `${source.prefix}${r.id}`;
            return { key: text, label: r.label ? `${text} ${r.label}` : text, insert: text };
        });
    }
    if (!token.startsWith('@')) return [];
    return filterMentions(mentions, token.slice(1), max).map((m) => ({ key: `@${m.id}`, label: m.label, insert: `@${m.label}` }));
}
