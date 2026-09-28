/**
 * Transcript steps (#1053; CHT-09, COL-09): what an agent DID in a turn, one runtime-neutral step per
 * tool call, so the thread can fold a turn's tool calls into one summary line (the steps box), and
 * the Team and Lanes views and the handoff lines build on one shared shape. Every runtime adapter
 * normalises its events to a `TranscriptStep` (design: HANDOFF.md § "Chat modes", "What the runtimes
 * must send"). Types plus pure helpers; no dependencies.
 */

import type { ChatEntry } from './chat.js';
import type { AgentId, TaskId } from './ids.js';

/** What a step is, for the summary counts. */
export type StepKind = 'read' | 'edit' | 'command' | 'search' | 'delegate' | 'other';

/** A step's state; maps one to one onto `ai-tool-call`'s `data-state`. */
export type StepState = 'running' | 'done' | 'error' | 'denied' | 'pending';

/** How an output excerpt was picked: the lines naming an error, or the last lines. */
export type ExcerptPick = 'error' | 'tail';

/** A bounded excerpt of a step's output (`pickExcerpt`). */
export interface StepExcerpt {
    /** How many lines the whole output has. */
    readonly lines: number;
    /** At most `EXCERPT_MAX_LINES` lines of it. */
    readonly excerpt: readonly string[];
    readonly picked: ExcerptPick;
}

export interface TranscriptStep {
    readonly id: string;
    readonly turnId: string;
    readonly agentId: AgentId;
    /** Drives the summary counts (`stepKindOf`). */
    readonly kind: StepKind;
    /** Shown as-is: `Bash`, `Read`, `Edit`. */
    readonly tool: string;
    /** One line: the command, path or query. */
    readonly target: string;
    readonly state: StepState;
    /** Short: `3 matches`, `+3 −2`. */
    readonly result?: string;
    readonly exitCode?: number;
    /** Optional: events recorded before #580 carry no time. */
    readonly startedAt?: number;
    readonly endedAt?: number;
    /** The excerpt; the full text stays in the Session, at `ref`. */
    readonly output?: StepExcerpt & { readonly ref: string };
    /** A `delegate` step: who the work went to. */
    readonly delegate?: { readonly to: AgentId; readonly taskId?: TaskId; readonly item?: string };
}

/** One turn's steps. `total` is the true count when `steps` is cut at a cap. */
export interface TurnSteps {
    readonly turnId: string;
    readonly steps: readonly TranscriptStep[];
    readonly total: number;
    readonly startedAt?: number;
    readonly endedAt?: number;
}

const DELEGATE_TOOLS = new Set(['delegate', 'tasks_delegate', 'plan_assign', 'plan_handoff']);

/**
 * A step's kind from its `@sigx/ai-agent/coding` category (`tool-call.category`) and tool name:
 * `execute` → `command`; `read` → `read`; `edit` / `delete` / `move` → `edit`; `search` / `fetch` →
 * `search`. The tools `delegate`, `tasks_delegate` (the MCP server's), `plan_assign` and `plan_handoff` (matched on the last segment of an
 * MCP-style `server__tool` name, case-insensitive) are `delegate`, whatever their category. Else `other`.
 */
export function stepKindOf(category?: string, tool?: string): StepKind {
    if (tool) {
        const name = tool.toLowerCase().split('__').pop()!;
        if (DELEGATE_TOOLS.has(name)) return 'delegate';
    }
    switch (category) {
        case 'execute':
            return 'command';
        case 'read':
            return 'read';
        case 'edit':
        case 'delete':
        case 'move':
            return 'edit';
        case 'search':
        case 'fetch':
            return 'search';
        default:
            return 'other';
    }
}

/**
 * Which failed steps (`state: 'error'`) the agent recovered from. The recovery rule: a failed step is
 * recovered when a LATER step of the same turn with the same `tool` and `target` ended `done` — the
 * agent retried the same thing and it worked. A different command, or a retry that failed again, does
 * not recover it.
 */
function recoveredFailures(steps: readonly TranscriptStep[]): { failed: number; recovered: number } {
    let failed = 0;
    let recovered = 0;
    steps.forEach((step, i) => {
        if (step.state !== 'error') return;
        failed++;
        if (steps.slice(i + 1).some((later) => later.state === 'done' && later.tool === step.tool && later.target === step.target)) recovered++;
    });
    return { failed, recovered };
}

export interface StepSummary {
    /** The turn's true step count (`TurnSteps.total`). */
    readonly total: number;
    /** Steps per kind, over the steps listed; a kind with none is absent. */
    readonly byKind: Readonly<Partial<Record<StepKind, number>>>;
    /** Steps that ended in error. */
    readonly failed: number;
    /** Of those, the ones a later step recovered (`turnOpensItself` has the rule). */
    readonly recovered: number;
    /** The turn's wall time, when its times (or its steps' times) are known. */
    readonly durationMs?: number;
}

export function summariseSteps(s: TurnSteps): StepSummary {
    const byKind: Partial<Record<StepKind, number>> = {};
    for (const step of s.steps) byKind[step.kind] = (byKind[step.kind] ?? 0) + 1;
    const { failed, recovered } = recoveredFailures(s.steps);
    const starts = s.steps.flatMap((x) => (x.startedAt === undefined ? [] : [x.startedAt]));
    const ends = s.steps.flatMap((x) => (x.endedAt === undefined ? [] : [x.endedAt]));
    const from = s.startedAt ?? (starts.length ? Math.min(...starts) : undefined);
    const to = s.endedAt ?? (ends.length ? Math.max(...ends) : undefined);
    const durationMs = from !== undefined && to !== undefined && to >= from ? to - from : undefined;
    return { total: s.total, byKind, failed, recovered, ...(durationMs === undefined ? {} : { durationMs }) };
}

const KIND_ORDER: readonly StepKind[] = ['command', 'read', 'edit', 'search', 'delegate', 'other'];
const KIND_NOUN: Record<StepKind, readonly [string, string]> = {
    command: ['command', 'commands'],
    read: ['read', 'reads'],
    edit: ['edit', 'edits'],
    search: ['search', 'searches'],
    delegate: ['handoff', 'handoffs'],
    other: ['other', 'others'],
};

/**
 * The steps box's summary line: `5 steps · 3 commands, 2 reads · 1 failed, recovered`, or
 * `3 steps · 3 commands · 1 failed`. Kinds by count, most first; a failure part only when a step
 * failed (`2 failed, 1 recovered` when only some were).
 */
export function formatStepSummary(summary: StepSummary): string {
    const parts = [`${summary.total} ${summary.total === 1 ? 'step' : 'steps'}`];
    const kinds = KIND_ORDER.filter((k) => summary.byKind[k])
        .sort((a, b) => summary.byKind[b]! - summary.byKind[a]! || KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b))
        .map((k) => `${summary.byKind[k]} ${KIND_NOUN[k][summary.byKind[k] === 1 ? 0 : 1]}`);
    if (kinds.length) parts.push(kinds.join(', '));
    if (summary.failed) {
        const recovered = !summary.recovered ? '' : summary.recovered === summary.failed ? ', recovered' : `, ${summary.recovered} recovered`;
        parts.push(`${summary.failed} failed${recovered}`);
    }
    return parts.join(' · ');
}

/** The most lines an output excerpt keeps. */
export const EXCERPT_MAX_LINES = 8;
/** Lines kept from the end when no line names an error. */
export const EXCERPT_TAIL_LINES = 3;
const ERROR_LINE = /error|failed|cannot|exception/i;

/**
 * A step output's excerpt, by the handoff rule: the lines matching `error`, `failed`, `cannot` or
 * `exception`, each with one line of context (the line before it); when none matches — whatever the
 * exit code — the last 3 lines; at most `EXCERPT_MAX_LINES` lines either way. A trailing newline
 * does not count as a line.
 */
export function pickExcerpt(text: string, _exitCode?: number): StepExcerpt {
    const all = text.split(/\r?\n/);
    if (all.length && all[all.length - 1] === '') all.pop();
    const keep = new Set<number>();
    all.forEach((line, i) => {
        if (!ERROR_LINE.test(line)) return;
        if (i > 0) keep.add(i - 1);
        keep.add(i);
    });
    if (keep.size) {
        const excerpt = [...keep].sort((a, b) => a - b).slice(0, EXCERPT_MAX_LINES).map((i) => all[i]!);
        return { lines: all.length, excerpt, picked: 'error' };
    }
    return { lines: all.length, excerpt: all.slice(-EXCERPT_TAIL_LINES), picked: 'tail' };
}

/** The note under an excerpt: `exit 1 · 2 of 14 lines, picked by error`. */
export function formatExcerptNote(output: StepExcerpt, exitCode?: number): string {
    const how = `${output.excerpt.length} of ${output.lines} ${output.lines === 1 ? 'line' : 'lines'}, picked by ${output.picked}`;
    return exitCode === undefined ? how : `exit ${exitCode} · ${how}`;
}

/**
 * Whether a finished turn's steps box opens itself: true when a failure stopped the work — a step
 * failed (`state: 'error'`) and no LATER step with the same `tool` and `target` ended `done`. A
 * failure the agent recovered from by retrying the same thing is named in the summary but stays shut.
 */
export function turnOpensItself(s: TurnSteps): boolean {
    const { failed, recovered } = recoveredFailures(s.steps);
    return failed > recovered;
}

/**
 * Who a chat entry is for, so the Team view can fold agent-to-agent talk: a user `msg` is for people;
 * an agent `msg` whose `mentions` name another member agent is for that agent (the first such);
 * anything else is for people.
 */
export function audienceOf(entry: ChatEntry, memberIds: readonly AgentId[]): 'people' | AgentId {
    if (entry.t !== 'msg' || entry.author.kind !== 'agent') return 'people';
    const self = entry.author.agentId;
    return entry.mentions.find((m) => m !== self && memberIds.includes(m)) ?? 'people';
}
