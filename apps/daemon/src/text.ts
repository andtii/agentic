/**
 * Whether file bytes are text a session-files answer may carry (#561): a NUL in the first `SNIFF_BYTES`, bytes that are
 * not UTF-8, or a control character `isBinaryText` rejects make them binary. One rule for reads and for the line counts
 * of untracked files.
 */

import { isBinaryText } from '@agentic/core';

/** Bytes sniffed for a NUL — and all that is read of a file too large to answer as text. */
export const SNIFF_BYTES = 8000;

/**
 * The text of `bytes`, or `undefined` when they are binary. With `prefix`, `bytes` are only a file's first bytes: a
 * multi-byte character cut at their end is not held against them.
 */
export function textOf(bytes: Buffer, prefix = false): string | undefined {
    if (bytes.subarray(0, SNIFF_BYTES).includes(0)) return undefined;
    let text: string;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: prefix });
    } catch {
        return undefined;
    }
    return isBinaryText(text) ? undefined : text;
}

export const lineCount = (text: string) => (text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0));
