/**
 * How the session's Changes and Files views reach its chat (#565), as pure
 * functions: a question about a line becomes a message whose `resource` part
 * carries the hunk (`agentic-session://<sessionId>/<path>#L<n>`), a file
 * mentioned from Files becomes an `@file:<path>` token in the chat's draft,
 * and a tool call that wrote a file becomes a "View diff" link — which files
 * a call wrote is the runtime's to say (`filesTouched`), never these views'.
 */
import { RESOURCE_TEXT_MAX_CHARS, parseSessionFileUri, sessionFileUri, type PromptPart } from '@agentic/core';
import { filesTouched, type ToolCallLike } from '@agentic/runtimes';
import { changesHref, type LineQuestion } from './files';

/** A file reference in a draft: `@file:` then the path relative to the session's folder, up to whitespace. */
export const FILE_TOKEN = '@file:';

/** `@file:<path>` for a path relative to the session's folder. */
export const fileToken = (path: string): string => `${FILE_TOKEN}${path}`;

/** Whether the `@` at `at` starts a file reference rather than an agent mention. */
export const isFileTokenAt = (text: string, at: number): boolean => text.startsWith(FILE_TOKEN, at);

/** The paths of the `@file:` tokens in a draft, each once, in order — sentence punctuation after a path is not part of it. */
export function fileTokensIn(text: string): string[] {
    const out: string[] = [];
    for (const m of text.matchAll(/(?:^|\s)@file:(\S+)/g)) {
        const path = m[1]!.replace(/[.,;:!?)\]]+$/, '');
        if (path && !out.includes(path)) out.push(path);
    }
    return out;
}

/** The `resource` part a line question carries: the file, the line, and the hunk around it (bounded). */
export function codeReferencePart(sessionId: string, q: Pick<LineQuestion, 'path' | 'ref' | 'hunk'>): Extract<PromptPart, { type: 'resource' }> {
    return { type: 'resource', uri: sessionFileUri(sessionId, q.path, q.ref.line), mediaType: 'text/x-diff', text: q.hunk.slice(0, RESOURCE_TEXT_MAX_CHARS) };
}

/** The `resource` parts for the files a message's `@file:` tokens name, in the session `sessionId`'s folder. */
export function fileReferenceParts(sessionId: string, text: string): PromptPart[] {
    return fileTokensIn(text).map((path) => ({ type: 'resource', uri: sessionFileUri(sessionId, path) }));
}

/** A `path:line` label for a session file URI, or the URI itself for any other. */
export function referenceLabel(uri: string): string {
    const ref = parseSessionFileUri(uri);
    if (!ref) return uri;
    return ref.line !== undefined ? `${ref.path}:${ref.line}` : ref.path;
}

/**
 * A `resource` part as text: its label, then its embedded snippet as a fenced block (a diff hunk reads as `diff`).
 * What the thread renders for it and what an activated agent reads in its objective.
 */
export function resourceText(part: Extract<PromptPart, { type: 'resource' }>): string {
    const label = referenceLabel(part.uri);
    if (!part.text) return `\`${label}\``;
    const lang = part.mediaType === 'text/x-diff' ? 'diff' : '';
    // A fence longer than any backtick run inside, so a hunk holding ``` stays one block.
    const longest = Math.max(2, ...[...part.text.matchAll(/`+/g)].map((m) => m[0].length));
    const fence = '`'.repeat(longest + 1);
    return `\`${label}\`\n${fence}${lang}\n${part.text.replace(/\n$/, '')}\n${fence}`;
}

/** The message a line question posts: the question, then the code reference. */
export function questionParts(sessionId: string, q: LineQuestion): PromptPart[] {
    return [{ type: 'text', text: q.text.trim() }, codeReferencePart(sessionId, q)];
}

/** The draft path of a chat opened to mention a file: `/chats/<id>?file=<sessionFileUri>`. */
export const mentionHref = (chatId: string, sessionId: string, path: string): string => `/chats/${encodeURIComponent(chatId)}?file=${encodeURIComponent(sessionFileUri(sessionId, path))}`;

/** The file a `?file=` query names for a mention: the session and the path, or `null` when it names none. */
export function mentionOfQuery(value: string | undefined): { readonly sessionId: string; readonly path: string } | null {
    const ref = value ? parseSessionFileUri(value) : null;
    return ref ? { sessionId: ref.sessionId, path: ref.path } : null;
}

/** "View diff" for a call that wrote a file, in the session that made it; nothing for a call that wrote none. */
export function viewDiffLinks(runtime: string | undefined, sessionId: string, call: ToolCallLike): { label: string; href: string }[] {
    const touched = filesTouched(runtime, call)[0];
    return touched ? [{ label: 'View diff', href: changesHref(sessionId, { file: touched.path }) }] : [];
}

/** The last call in `calls` that wrote each file, by the path as the call gave it — "Edited by … Edit" in a file's header. */
export function lastTouches<C extends ToolCallLike>(runtime: string | undefined, calls: readonly C[]): Map<string, C> {
    const out = new Map<string, C>();
    for (const call of calls) for (const t of filesTouched(runtime, call)) out.set(t.path, call);
    return out;
}
