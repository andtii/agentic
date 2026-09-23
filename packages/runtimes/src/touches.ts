/**
 * Which files a tool call touched, per runtime (#565): the knowledge of a
 * runtime's tool names lives with the runtime, never in the pages. The web
 * app asks `filesTouched(runtime, call)` for the "View diff" link on a tool
 * card and the "Edited by" line in the Changes view; a runtime with no
 * extractor touches nothing, and those links just do not show. Claude Code
 * is registered here; another runtime (or a test) adds its own with
 * `registerFileTouches`.
 */
import type { FileTouch } from '@agentic/core';
import { claudeCodeFileTouches } from './claude-code/touches.js';
import { CLAUDE_CODE_PLUGIN_ID } from './plugins.js';

/** The slice of a tool call an extractor reads: a transcript's tool part and a `tool-call` event both fit. */
export interface ToolCallLike {
    readonly name: string;
    readonly input?: unknown;
}

/** Reads the files a call touched out of its input; `[]` for a call that touches none. */
export type FileTouchExtractor = (call: ToolCallLike) => readonly FileTouch[];

const extractors = new Map<string, FileTouchExtractor>([[CLAUDE_CODE_PLUGIN_ID, claudeCodeFileTouches]]);

/** Register (or replace) `runtime`'s extractor; the returned function restores what was there before. */
export function registerFileTouches(runtime: string, extractor: FileTouchExtractor): () => void {
    const before = extractors.get(runtime);
    extractors.set(runtime, extractor);
    return () => {
        if (extractors.get(runtime) !== extractor) return;
        if (before) extractors.set(runtime, before);
        else extractors.delete(runtime);
    };
}

/** The files `call` touched, as `runtime`'s extractor reads them; `[]` for a runtime without one. */
export function filesTouched(runtime: string | undefined, call: ToolCallLike): FileTouch[] {
    const extract = runtime ? extractors.get(runtime) : undefined;
    return extract ? [...extract(call)] : [];
}
