/**
 * Step normalisers, per runtime (#1055; CHT-09, COL-09): what one tool call of a turn says as a `TranscriptStep` —
 * its kind, a one-line target, a short result and an exit code. The knowledge of a runtime's tool names lives with
 * the runtime (the `touches.ts` pattern): the Session asks `normaliseStep(runtime, call)` for every call of a finished
 * turn. Claude Code, Codex and Copilot are registered here; any other runtime (`anthropic-api`) takes the fallback —
 * the kind from `stepKindOf(category, name)` and no target, which the Session fills from the call's activity line.
 * The platform's `delegate`, `plan_assign` and `plan_handoff` are `delegate` steps on every runtime. Pure and edge-safe.
 */
import { stepKindOf, type AgentId, type StepKind, type TaskId, type TranscriptStep } from '@agentic/core';
import { claudeCodeStep } from './steps/claude-code.js';
import { codexCliStep } from './steps/codex-cli.js';
import { copilotCliStep } from './steps/copilot-cli.js';
import { isRecord, oneLine, stringField } from './steps/text.js';
import { CLAUDE_CODE_PLUGIN_ID, CODEX_CLI_PLUGIN_ID, COPILOT_CLI_PLUGIN_ID } from './plugins.js';

export { stepOutputText } from './steps/text.js';

/** One settled `coding.diff` of a call: the text it replaced and the text it wrote. */
export interface StepDiff {
    readonly oldText?: string;
    readonly newText?: string;
}

/** The slice of a tool call a normaliser reads: the call, how it settled, and the `coding.diff`s it emitted. */
export interface StepCall {
    readonly name: string;
    readonly input?: unknown;
    readonly output?: unknown;
    readonly error?: string;
    readonly category?: string;
    readonly diffs?: readonly StepDiff[];
}

/** What a normaliser reads out of a call. `target` is one line; empty when the runtime cannot name one. */
export interface NormalisedStep {
    readonly kind: StepKind;
    readonly target: string;
    readonly result?: string;
    readonly exitCode?: number;
    readonly delegate?: TranscriptStep['delegate'];
}

/** A runtime's reading of a call; anything it leaves out comes from the fallback. */
export type StepNormaliser = (call: StepCall) => Partial<NormalisedStep>;

const normalisers = new Map<string, StepNormaliser>([
    [CLAUDE_CODE_PLUGIN_ID, claudeCodeStep],
    [CODEX_CLI_PLUGIN_ID, codexCliStep],
    [COPILOT_CLI_PLUGIN_ID, copilotCliStep]
]);

/** Register (or replace) `runtime`'s normaliser; the returned function restores what was there before. */
export function registerStepNormaliser(runtime: string, normaliser: StepNormaliser): () => void {
    const before = normalisers.get(runtime);
    normalisers.set(runtime, normaliser);
    return () => {
        if (normalisers.get(runtime) !== normaliser) return;
        if (before) normalisers.set(runtime, before);
        else normalisers.delete(runtime);
    };
}

/** The longest a step's target is kept. */
export const STEP_TARGET_MAX = 120;
/** The longest a step's short result is kept. */
export const STEP_RESULT_MAX = 60;

/** A task id out of a delegate call's input (`follow`) or its result (`{taskId}`, or a JSON text carrying one). */
function taskIdOf(call: StepCall): string | undefined {
    const fromOutput = (() => {
        if (isRecord(call.output) && typeof call.output.taskId === 'string') return call.output.taskId;
        const text = typeof call.output === 'string' ? call.output : undefined;
        return text?.match(/"taskId"\s*:\s*"([^"]+)"/)?.[1];
    })();
    return fromOutput ?? stringField(call.input, 'follow', 'taskId');
}

/** A `delegate` step's destination: `delegate`'s `assignee`, the plan tools' `to` (a handle, `@` dropped) and `item`. */
function delegateOf(call: StepCall): TranscriptStep['delegate'] | undefined {
    const to = stringField(call.input, 'assignee', 'to')?.replace(/^@/, '');
    if (!to) return undefined;
    const taskId = taskIdOf(call);
    const item = isRecord(call.input) && (typeof call.input.item === 'number' || typeof call.input.item === 'string') ? String(call.input.item) : undefined;
    return { to: to as AgentId, ...(taskId ? { taskId: taskId as TaskId } : {}), ...(item ? { item } : {}) };
}

function clip(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** `call` as `runtime` reads it, over the fallback; a delegate tool is a `delegate` step on any runtime. */
export function normaliseStep(runtime: string | undefined, call: StepCall): NormalisedStep {
    const own = (runtime ? normalisers.get(runtime) : undefined)?.(call) ?? {};
    const fallbackKind = stepKindOf(call.category, call.name);
    const kind = fallbackKind === 'delegate' ? 'delegate' : (own.kind ?? fallbackKind);
    const target = clip(oneLine(own.target ?? ''), STEP_TARGET_MAX);
    const result = own.result === undefined ? undefined : clip(oneLine(own.result), STEP_RESULT_MAX);
    const delegate = kind === 'delegate' ? (own.delegate ?? delegateOf(call)) : undefined;
    return {
        kind,
        target: target || (delegate ? delegate.to : ''),
        ...(result ? { result } : {}),
        ...(own.exitCode !== undefined ? { exitCode: own.exitCode } : {}),
        ...(delegate ? { delegate } : {})
    };
}
