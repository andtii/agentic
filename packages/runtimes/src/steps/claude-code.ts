/**
 * Claude Code's tool calls as steps (#1055): `Bash` names its command and says its exit code (a failed Bash's result
 * text starts `Exit code N`; a completed one exited 0, whatever its output prints); `Read`, `Write`, `Edit`, `MultiEdit` and `NotebookEdit` name
 * their file, and an edit says `+a −b` from its `coding.diff`s (else from its own input); `Grep` and `Glob` name their
 * pattern and say `N matches`. Anything else names what its input names.
 */
import type { NormalisedStep, StepCall } from '../steps.js';
import { diffCounts, formatDiff, genericTarget, isRecord, matches, stepOutputText, stringField } from './text.js';

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** The exit code a Bash result names (`Exit code 2`, `exit code: 2`); `undefined` when it names none. */
export function exitCodeIn(text: string): number | undefined {
    const m = text.match(/exit(?:ed with)? code:?\s*(-?\d+)/i);
    return m ? Number(m[1]) : undefined;
}

/** How many hits a Grep or Glob answer lists: its own `Found N …` count, `0` for `No … found`, else its non-empty lines. */
export function matchCount(text: string): number {
    const found = text.match(/^Found (\d+)/m);
    if (found) return Number(found[1]);
    if (/^No (files|matches) found/m.test(text.trim())) return 0;
    return text.split(/\r?\n/).filter((l) => l.trim()).length;
}

/** `+a −b` from the call's diffs, else from its input (`old_string`/`new_string`, MultiEdit's `edits`, Write's `content`). */
function editResult(call: StepCall): string | undefined {
    if (call.diffs?.length) return formatDiff(call.diffs.map((d) => diffCounts(d.oldText, d.newText)));
    if (!isRecord(call.input)) return undefined;
    const input = call.input;
    if (call.name === 'Write') return typeof input.content === 'string' ? formatDiff([diffCounts(undefined, input.content)]) : undefined;
    const edits = Array.isArray(input.edits) ? input.edits.filter(isRecord) : [input];
    const counts = edits.filter((e) => typeof e.old_string === 'string' || typeof e.new_string === 'string').map((e) => diffCounts(e.old_string as string | undefined, e.new_string as string | undefined));
    return formatDiff(counts);
}

export function claudeCodeStep(call: StepCall): Partial<NormalisedStep> {
    if (call.name === 'Bash') {
        // A failure's result text names its exit code; a completed Bash exited 0, whatever its output says.
        const exitCode = call.error !== undefined ? exitCodeIn(call.error) : call.output !== undefined ? 0 : undefined;
        return { kind: 'command', target: stringField(call.input, 'command') ?? '', ...(exitCode !== undefined ? { exitCode } : {}) };
    }
    if (FILE_TOOLS.has(call.name)) {
        const result = EDIT_TOOLS.has(call.name) && call.error === undefined ? editResult(call) : undefined;
        return { kind: call.name === 'Read' ? 'read' : 'edit', target: stringField(call.input, 'file_path', 'notebook_path') ?? '', ...(result ? { result } : {}) };
    }
    if (call.name === 'Grep' || call.name === 'Glob') {
        const done = call.error === undefined && call.output !== undefined;
        return { kind: 'search', target: stringField(call.input, 'pattern') ?? '', ...(done ? { result: matches(matchCount(stepOutputText(call.output))) } : {}) };
    }
    return { target: genericTarget(call.input) ?? '' };
}
