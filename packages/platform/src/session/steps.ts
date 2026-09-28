/**
 * A finished turn as steps (#1055; CHT-09, COL-09): the Session folds the turn's top-level `tool-call` and
 * `tool-update` events (and the `coding.diff`s a call emitted) into one `TurnSteps`, each call normalised by its
 * runtime (`normaliseStep` in `@agentic/runtimes`), and attaches it to the turn's final chat `msg`. The chat window
 * stays small: at most `TURN_STEPS_CAP` steps (`total` stays true), one-line targets, and an output excerpt only on a
 * failed step (the last `TURN_EXCERPTS_MAX` of them) — the full input and output stay in the Session, at `output.ref`
 * (`<sessionId>#<callId>`). Pure.
 */
import { pickExcerpt, type AgentId, type StepState, type TranscriptStep, type TurnSteps } from '@agentic/core';
import { normaliseStep, stepOutputText, type StepDiff } from '@agentic/runtimes';
import type { AgentEvent } from '@sigx/ai-agent';

import { toolActivity } from './activity.js';
import { eventTime } from './state.js';

/** The most steps one turn's summary lists. */
export const TURN_STEPS_CAP = 60;
/** The longest one excerpt line is kept. */
export const EXCERPT_LINE_MAX = 120;
/** The most failed steps of one turn that keep an excerpt: the last ones — the failure that stopped the work is among them. */
export const TURN_EXCERPTS_MAX = 8;

interface Call {
    readonly callId: string;
    readonly name: string;
    readonly input?: unknown;
    readonly title?: string;
    readonly category?: string;
    readonly startedAt?: number;
    status: string;
    output?: unknown;
    error?: string;
    endedAt?: number;
    readonly diffs: StepDiff[];
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'denied']);

function stateOf(status: string): StepState {
    switch (status) {
        case 'completed':
            return 'done';
        case 'failed':
            return 'error';
        // A call cancelled by Stop is skipped, not failed — as the UI's live `stepState` shows it (#1097).
        case 'cancelled':
        case 'denied':
            return 'denied';
        case 'in_progress':
            return 'running';
        default:
            return 'pending';
    }
}

const parentOf = (ev: AgentEvent): string | undefined => (ev as { readonly parentCallId?: string }).parentCallId;

export interface TurnStepsInput {
    readonly turnId: string;
    readonly agentId: AgentId;
    /** The platform session id: `output.ref` is `<sessionId>#<callId>`. */
    readonly sessionId: string;
    /** The runtime whose normaliser reads the calls. */
    readonly runtime?: string;
    readonly cap?: number;
}

/**
 * `events` (any slice of the log that holds the turn; other turns' events are skipped) as the turn's steps, in call
 * order. `undefined` when the turn made no tool call. A sub-agent's own calls (a `parentCallId`) are not steps.
 */
export function foldTurnSteps(events: readonly AgentEvent[], input: TurnStepsInput): TurnSteps | undefined {
    const calls = new Map<string, Call>();
    let startedAt: number | undefined;
    let endedAt: number | undefined;
    for (const ev of events) {
        if (ev.turnId !== input.turnId) continue;
        const at = eventTime(ev);
        switch (ev.type) {
            case 'turn-start':
                startedAt = at;
                break;
            case 'turn-end':
                endedAt = at;
                break;
            case 'tool-call':
                if (parentOf(ev) !== undefined || calls.has(ev.callId)) break;
                calls.set(ev.callId, {
                    callId: ev.callId,
                    name: ev.name,
                    ...(ev.input !== undefined ? { input: ev.input } : {}),
                    ...(ev.title ? { title: ev.title } : {}),
                    ...(ev.category ? { category: ev.category } : {}),
                    ...(at !== undefined ? { startedAt: at } : {}),
                    status: 'pending',
                    diffs: []
                });
                break;
            case 'tool-update': {
                const call = calls.get(ev.callId);
                if (!call || parentOf(ev) !== undefined) break;
                call.status = ev.status;
                if (ev.output !== undefined) call.output = ev.output;
                if (ev.error !== undefined) call.error = ev.error;
                if (TERMINAL.has(ev.status) && at !== undefined) call.endedAt = at;
                break;
            }
            case 'ext': {
                // Claude Code's `coding.diff` names the call it belongs to as its `parentCallId`.
                const call = ev.ns === 'coding' && ev.name === 'diff' ? calls.get(parentOf(ev) ?? '') : undefined;
                const data = ev.data as { readonly oldText?: unknown; readonly newText?: unknown } | null;
                if (call && data && typeof data === 'object') {
                    call.diffs.push({ ...(typeof data.oldText === 'string' ? { oldText: data.oldText } : {}), ...(typeof data.newText === 'string' ? { newText: data.newText } : {}) });
                }
                break;
            }
            default:
                break;
        }
    }
    if (!calls.size) return undefined;
    const cap = input.cap ?? TURN_STEPS_CAP;
    const kept = [...calls.values()].slice(0, cap);
    const failed = kept.filter((call) => stateOf(call.status) === 'error');
    const excerpted = new Set(failed.slice(-TURN_EXCERPTS_MAX));
    const steps = kept.map((call) => stepOf(call, input, excerpted.has(call)));
    return { turnId: input.turnId, steps, total: calls.size, ...(startedAt !== undefined ? { startedAt } : {}), ...(endedAt !== undefined ? { endedAt } : {}) };
}

function stepOf(call: Call, input: TurnStepsInput, withExcerpt: boolean): TranscriptStep {
    const n = normaliseStep(input.runtime, {
        name: call.name,
        ...(call.input !== undefined ? { input: call.input } : {}),
        ...(call.output !== undefined ? { output: call.output } : {}),
        ...(call.error !== undefined ? { error: call.error } : {}),
        ...(call.category ? { category: call.category } : {}),
        ...(call.diffs.length ? { diffs: call.diffs } : {})
    });
    const state = stateOf(call.status);
    // The excerpt only on a failure: what the steps box opens on; a done step's output stays in the Session.
    const text = withExcerpt ? stepOutputText(call.output) || call.error || '' : '';
    const excerpt = text ? pickExcerpt(text, n.exitCode) : undefined;
    const target = n.target || toolActivity({ name: call.name, input: call.input, ...(call.title ? { title: call.title } : {}) }).slice(0, 120);
    return {
        id: call.callId,
        turnId: input.turnId,
        agentId: input.agentId,
        kind: n.kind,
        tool: call.name,
        target,
        state,
        ...(n.result ? { result: n.result } : {}),
        ...(n.exitCode !== undefined ? { exitCode: n.exitCode } : {}),
        ...(call.startedAt !== undefined ? { startedAt: call.startedAt } : {}),
        ...(call.endedAt !== undefined ? { endedAt: call.endedAt } : {}),
        ...(excerpt ? { output: { ...excerpt, excerpt: excerpt.excerpt.map((l) => (l.length > EXCERPT_LINE_MAX ? `${l.slice(0, EXCERPT_LINE_MAX - 1)}…` : l)), ref: `${input.sessionId}#${call.callId}` } } : {}),
        ...(n.delegate ? { delegate: n.delegate } : {})
    };
}
