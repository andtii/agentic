/**
 * A running task's current activity from its session's tool calls (#955): the Session actor sees every `tool-call` of
 * a task's turn and notes one short line on that task (`Task.note({ activity })`, #937) — "Running pnpm test",
 * "Editing live.ts" — so the Work view says what an active task is on instead of "Working". Throttled per session:
 * a burst of calls is one note, never a Task write per call.
 */

import type { TaskId } from '@agentic/core';
import type { AgentEvent } from '@sigx/ai-agent';

/** The least time between two activity notes from one session for the same task. */
export const ACTIVITY_THROTTLE_MS = 3_000;

type ToolCall = Extract<AgentEvent, { type: 'tool-call' }>;

/** The last path segment, either separator. */
function baseName(path: string): string {
    const parts = path.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? path;
}

function stringField(input: unknown, ...keys: readonly string[]): string | undefined {
    if (!input || typeof input !== 'object') return undefined;
    for (const key of keys) {
        const value = (input as Record<string, unknown>)[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return undefined;
}

/**
 * The one line a tool call says about the work: the runtime's own `title` when it gave one, else a command it runs
 * (`Running …`), a file it edits, writes or reads (by its base name), else `Using {tool}`. Whitespace is collapsed;
 * the Task clips the length.
 */
export function toolActivity(call: Pick<ToolCall, 'name' | 'input' | 'title'>): string {
    const line = (() => {
        if (call.title?.trim()) return call.title;
        const command = stringField(call.input, 'command', 'cmd');
        if (command) return `Running ${command}`;
        const file = stringField(call.input, 'file_path', 'filePath', 'path', 'notebook_path');
        if (file) {
            const verb = /edit|write|patch|replace/i.test(call.name) ? 'Editing' : /read|view/i.test(call.name) ? 'Reading' : call.name;
            return `${verb} ${baseName(file)}`;
        }
        return `Using ${call.name}`;
    })();
    return line.replace(/\s+/g, ' ').trim();
}

/** What a session last noted, for the throttle. */
export interface ActivityMark {
    readonly taskId: TaskId;
    readonly at: number;
}

/** Whether a call at `at` for `taskId` is noted: always for another task than the last note's, else once the throttle has passed (or the clock went back). */
export function shouldNoteActivity(last: ActivityMark | undefined, taskId: TaskId, at: number, throttleMs = ACTIVITY_THROTTLE_MS): boolean {
    return !last || last.taskId !== taskId || at < last.at || at - last.at >= throttleMs;
}
