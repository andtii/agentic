/**
 * The pure side of the steps box (#1054): a step's look, the times the box prints, and the steps of a
 * turn still in flight, read off its tool parts (`stepsFromToolParts`) until the chat entry carries
 * its own `steps` (`TurnSteps`, #1053).
 */
import { pickExcerpt, stepKindOf, type AgentId, type StepState, type TranscriptStep, type TurnSteps } from '@agentic/core';
import type { AgentMessage, AgentPart, AgentTranscript, ToolPartState } from '@sigx/ai-agent/app';
import type { IconName } from '../kit/icons.js';
import { outputText, signature, nonBlank, oneLine } from '../thread/text.js';
import type { STEP_STATES } from './anatomy.js';

export type StepLifecycle = (typeof STEP_STATES)[number];

/** A step's line, by state (`docs/design/chat-modes/HANDOFF.md` → "Parts and rules"). */
export interface StepLook {
    /** `data-state`: the governed lifecycle value. */
    readonly state: StepLifecycle;
    /** The status icon; `null` for the spinner a running step shows. */
    readonly icon: IconName | null;
    /** The accessible name of the status. */
    readonly label: string;
}

const LOOKS: Record<StepState, StepLook> = {
    done: { state: 'complete', icon: 'check', label: 'done' },
    running: { state: 'running', icon: null, label: 'running' },
    error: { state: 'error', icon: 'close', label: 'failed' },
    pending: { state: 'loading', icon: 'shield', label: 'needs approval' },
    denied: { state: 'denied', icon: 'chevron-right', label: 'denied or skipped' }
};

export function stepLook(state: StepState): StepLook {
    return LOOKS[state];
}

/** `0.1s`, `2.4s`, `18s`, `1m 12s`, `1h 3m`: one decimal under ten seconds, whole seconds above. */
export function formatStepDuration(ms: number): string {
    if (ms < 0) return '';
    const s = ms / 1000;
    if (s < 10) return `${Number(s.toFixed(1))}s`;
    const whole = Math.round(s);
    if (whole < 60) return `${whole}s`;
    const m = Math.floor(whole / 60);
    if (m < 60) return `${m}m ${whole % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * The duration column: the step's wall time once it ended, the time so far while it runs (against
 * `now`), `waits` on an approval, `—` for a step that was denied or skipped, else empty.
 */
export function stepDuration(step: TranscriptStep, now: number = Date.now()): string {
    if (step.state === 'pending') return 'waits';
    if (step.state === 'denied') return '—';
    if (step.startedAt === undefined) return '';
    const end = step.endedAt ?? (step.state === 'running' ? now : undefined);
    return end === undefined ? '' : formatStepDuration(end - step.startedAt);
}

/** The result column: the step's own, or `needs approval` for a step waiting on one. */
export function stepResult(step: TranscriptStep): string | undefined {
    return nonBlank(step.result) ?? (step.state === 'pending' ? 'needs approval' : undefined);
}

function stepState(p: ToolPartState, transcript?: AgentTranscript): StepState {
    switch (p.status) {
        case 'completed':
            return 'done';
        case 'denied':
        case 'cancelled':
            return 'denied';
        case 'streaming':
        case 'pending':
            return p.requestId !== undefined && transcript?.requests[p.requestId] !== undefined ? 'pending' : 'running';
        case 'in_progress':
            return 'running';
        default:
            return 'error';
    }
}

/** A tool part's one-line target: the first argument's value (`npx sigx zero:build`, a path, a query). */
function targetOf(p: ToolPartState): string {
    if (p.status === 'streaming') return oneLine(p.inputText ?? '');
    const input = p.input;
    if (input && typeof input === 'object') {
        const first = Object.values(input as Record<string, unknown>)[0];
        if (typeof first === 'string') return oneLine(first);
    }
    return signature(input);
}

/**
 * The steps of a turn still in flight, read off the message's tool parts: one step per tool part,
 * its kind from the part's category and name (`stepKindOf`), its state from the part's status (a
 * pending call with an open request in `transcript` is `pending` — it waits on an approval), and a
 * failed call's excerpt picked from its output or error (`pickExcerpt`, `ref` is the call id). The
 * parts carry no times, so neither do the steps.
 */
export function stepsFromToolParts(message: AgentMessage, transcript?: AgentTranscript): TurnSteps {
    const turnId = message.turnId ?? message.id;
    const agentId = (message.actor ?? message.author ?? '') as AgentId;
    const tools = message.parts.filter((p: AgentPart): p is ToolPartState => p.type === 'tool');
    const steps = tools.map((p): TranscriptStep => {
        const state = stepState(p, transcript);
        const text = state === 'error' ? nonBlank(p.error) ?? outputText(p) : undefined;
        return {
            id: p.callId,
            turnId,
            agentId,
            kind: stepKindOf(p.category, p.name),
            tool: p.name,
            target: targetOf(p),
            state,
            ...(text ? { output: { ...pickExcerpt(text), ref: p.callId } } : {})
        };
    });
    return { turnId, steps, total: steps.length };
}
