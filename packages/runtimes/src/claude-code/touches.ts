/**
 * The files a Claude Code tool call writes (#565): its editing tools name the
 * file in their input — `file_path` for Edit, MultiEdit and Write,
 * `notebook_path` for NotebookEdit. Every other tool (Read, Bash, …) touches
 * nothing this reports. Pure and edge-safe: the browser bundle imports it
 * through the touched-files registry, never the driver.
 */
import type { FileTouch } from '@agentic/core';
import type { ToolCallLike } from '../touches.js';

/** Claude Code's editing tools and the input key each names its file under. */
export const CLAUDE_CODE_EDIT_TOOLS: Readonly<Record<string, string>> = {
    Edit: 'file_path',
    MultiEdit: 'file_path',
    Write: 'file_path',
    NotebookEdit: 'notebook_path'
};

export function claudeCodeFileTouches(call: ToolCallLike): FileTouch[] {
    const key = Object.hasOwn(CLAUDE_CODE_EDIT_TOOLS, call.name) ? CLAUDE_CODE_EDIT_TOOLS[call.name] : undefined;
    if (!key || typeof call.input !== 'object' || call.input === null) return [];
    const path = (call.input as Record<string, unknown>)[key];
    const trimmed = typeof path === 'string' ? path.trim() : '';
    return trimmed ? [{ path: trimmed }] : [];
}
