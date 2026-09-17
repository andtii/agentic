/**
 * Tokenizer shared by indexing and querying — the same function on both
 * sides, so a term matches itself. Unicode letters and digits form tokens;
 * everything else separates. One-character tokens and a small English stop
 * list are dropped: they carry no signal and inflate document length.
 */

const STOP_WORDS: ReadonlySet<string> = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'with'
]);

const SEPARATOR = /[^\p{L}\p{N}]+/u;

export function tokenize(text: string): string[] {
    const out: string[] = [];
    for (const raw of text.toLowerCase().split(SEPARATOR)) {
        if (raw.length < 2 || STOP_WORDS.has(raw)) continue;
        out.push(raw);
    }
    return out;
}

/** Tags compare case-insensitively and ignore surrounding whitespace. */
export function normalizeTag(tag: string): string {
    return tag.trim().toLowerCase();
}

/** Term → occurrences, for one document. */
export function termFrequencies(tokens: readonly string[]): Map<string, number> {
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    return tf;
}
