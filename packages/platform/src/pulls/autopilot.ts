/**
 * Autopilot (#743; PRJ-09; architecture §10 "Projects (redesign)") — the PR's agent keeps it moving within the four
 * switches of core's `Autopilot`, and hands it to you when it cannot.
 *
 * `stepAutopilot(pilot, run, pr, now)` is the state machine: pure, one observation of the PR in, the next run state
 * and the actions to take out. `driveAutopilot(ports, …)` takes the actions through an `AutopilotPort` (start a
 * turn in the PR's chat, merge through the approval rule `ask on merge`, say it is your move) and folds a merge's
 * answer back. The Pulls actor is to keep one `AutopilotRun` per PR and drive it after every poll (wiring: follow-up).
 *
 * One turn at a time, in the order things block a merge:
 * - **rebase** — the PR conflicts with its base: one turn to rebase; still conflicting after it, it stops.
 * - **fixChecks** — a check failed (and none is still running): a turn with the failure detail, up to `maxAttempts`;
 *   failing after the last one, it gives up. Green resets the count.
 * - **answerThreads** — a review thread it has not taken up yet: a turn to answer or fix it.
 * - **mergeWhenGreen** — nothing blocks and the review is approved: merge, asked once per green run through
 *   `ask on merge`; a declined merge stops it.
 * A switch that is off leaves that job to you. A stop (`gave-up`, `conflicts`, `merge-declined`, `no-chat`,
 * `taken-over`) is your move until `resumeAutopilot`; `stopAutopilot` switches it off.
 */
import { pullBlockers, type AgentId, type ApprovalRule, type Autopilot, type ChatId, type PullRequest, type TaskId } from '@agentic/core';

// ---------------------------------------------------------------------------
// State

export type AutopilotTurnKind = 'fix' | 'threads' | 'rebase';

/** A turn the autopilot started in the PR's chat, until the PR shows its effect or it has had time to. */
export interface AutopilotTurn {
    readonly kind: AutopilotTurnKind;
    readonly startedAt: number;
    /** When the chat said the turn ended (`autopilotTurnEnded`). */
    readonly endedAt?: number;
    /** The task the turn runs as, when the port said (#858): its end is the turn's end. */
    readonly taskId?: TaskId;
    /** fix: the checks that were failing. */
    readonly checks?: readonly string[];
    /** threads: the thread ids it took up. */
    readonly threads?: readonly string[];
}

export type AutopilotStopReason = 'gave-up' | 'conflicts' | 'merge-declined' | 'no-chat' | 'taken-over';

export interface AutopilotStop {
    readonly reason: AutopilotStopReason;
    /** One line for the PR page and the notification. */
    readonly detail: string;
    readonly at: number;
}

/** What the autopilot remembers about one PR. */
export interface AutopilotRun {
    /** Fix attempts used on the current failure run (reset when the checks go green). */
    readonly attempts: number;
    readonly turn?: AutopilotTurn;
    /** Thread ids already taken up (only those still on the PR are kept). */
    readonly answered: readonly string[];
    /** A rebase turn already ran for the current conflict. */
    readonly rebased?: boolean;
    /** A merge was asked for on the current green run. */
    readonly mergeAsked?: boolean;
    /** Stopped: your move, until resumed. */
    readonly stopped?: AutopilotStop;
    /** Switched off (`Stop autopilot`). */
    readonly off?: boolean;
}

export const NEW_AUTOPILOT_RUN: AutopilotRun = { attempts: 0, answered: [] };

/** The approval rule every autopilot merge goes through: the merge tool always asks. */
export const ASK_ON_MERGE: ApprovalRule = { id: 'ask-on-merge', match: { tools: ['pull_merge'] }, outcome: 'ask', scope: 'once' };
/** After a turn ended, how long the PR has to show its effect (a push starts checks) before the autopilot moves on. */
export const AUTOPILOT_SETTLE_MS = 5 * 60_000;
/** A turn the chat never reported ended is given up on after this long. */
export const AUTOPILOT_TURN_STALE_MS = 60 * 60_000;
/** The attempt limit when the switches name none. */
export const AUTOPILOT_DEFAULT_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Actions

export type AutopilotAction =
    /** Start a turn for `agentId` in the PR's chat with `text`. */
    | { readonly kind: 'turn'; readonly turn: AutopilotTurnKind; readonly agentId: AgentId; readonly chatId: ChatId; readonly taskId?: TaskId; readonly text: string }
    /** Merge, through `rule`. */
    | { readonly kind: 'merge'; readonly agentId: AgentId; readonly rule: ApprovalRule }
    /** It stopped: the next move is yours. */
    | { readonly kind: 'your-move'; readonly stop: AutopilotStop };

export interface AutopilotStep {
    readonly run: AutopilotRun;
    readonly actions: readonly AutopilotAction[];
}

const attemptsOf = (pilot: Autopilot): number =>
    Number.isSafeInteger(pilot.maxAttempts) && pilot.maxAttempts > 0 ? pilot.maxAttempts : AUTOPILOT_DEFAULT_ATTEMPTS;

const isPending = (pr: PullRequest): boolean => pr.checks.some((c) => c.state === 'queued' || c.state === 'running');
const failingOf = (pr: PullRequest) => pr.checks.filter((c) => c.state === 'failed');
/** Threads the agent should take up: open, not its own, not yet taken up. */
const newThreads = (pilot: Autopilot, run: AutopilotRun, pr: PullRequest) =>
    pr.review.threads.filter((t) => t.state === 'open' && t.author !== pilot.agentId && !run.answered.includes(t.id));

/** Whether the PR shows the turn's effect, so the turn is over. */
function turnShows(turn: AutopilotTurn, pr: PullRequest): boolean {
    switch (turn.kind) {
        case 'fix':
            return isPending(pr) || failingOf(pr).length === 0;
        case 'rebase':
            return pr.mergeable !== false;
        case 'threads':
            return (turn.threads ?? []).every((id) => pr.review.threads.find((t) => t.id === id)?.state !== 'open');
    }
}

/** Whether a turn still holds the PR: it has not shown its effect, and has not had its time. */
function turnHolds(turn: AutopilotTurn, pr: PullRequest, now: number): boolean {
    if (turnShows(turn, pr)) return false;
    if (turn.endedAt !== undefined) return now - turn.endedAt < AUTOPILOT_SETTLE_MS;
    return now - turn.startedAt < AUTOPILOT_TURN_STALE_MS;
}

function fixText(pr: PullRequest, failing: readonly { name: string; detail?: string }[], attempt: number, max: number): string {
    const lines = failing.map((c) => `- ${c.name}${c.detail ? `: ${c.detail.slice(0, 2000)}` : ''}`);
    return [
        `Autopilot: ${failing.length === 1 ? 'a check is' : `${failing.length} checks are`} failing on pull request #${pr.number} (${pr.head} → ${pr.base}). Attempt ${attempt} of ${max}.`,
        ...lines,
        'Find the cause, fix it on the branch and push. Do not merge.'
    ].join('\n');
}

function threadsText(pr: PullRequest, threads: readonly { id: string; author: string; path?: string; line?: number; body: string }[]): string {
    const lines = threads.map((t) => `- [${t.id}] ${t.author}${t.path ? ` on ${t.path}${t.line !== undefined ? `:${t.line}` : ''}` : ''}: ${t.body.slice(0, 2000)}`);
    return [
        `Autopilot: ${threads.length === 1 ? 'a new review thread' : `${threads.length} new review threads`} on pull request #${pr.number}.`,
        ...lines,
        'Answer each one, or fix what it asks on the branch and push, then reply saying what changed. Do not merge.'
    ].join('\n');
}

const rebaseText = (pr: PullRequest): string =>
    `Autopilot: pull request #${pr.number} (${pr.head}) conflicts with ${pr.base}. Rebase it onto ${pr.base} and push. If the conflicts need a decision, stop and say so — do not guess.`;

// ---------------------------------------------------------------------------
// The state machine

/**
 * One observation of `pr` → the next run and what to do. Pure: the caller keeps the run and takes the actions
 * (`driveAutopilot`). Nothing happens on a PR that is not open, without switches, switched off or stopped.
 */
export function stepAutopilot(pilot: Autopilot | undefined, run: AutopilotRun, pr: PullRequest, now: number): AutopilotStep {
    if (!pilot || run.off || run.stopped || pr.state !== 'open') return { run, actions: [] };
    let next: AutopilotRun = { ...run, answered: run.answered.filter((id) => pr.review.threads.some((t) => t.id === id)) };
    const stop = (reason: AutopilotStopReason, detail: string): AutopilotStep => {
        const s: AutopilotStop = { reason, detail, at: now };
        const { turn: _turn, ...rest } = next;
        return { run: { ...rest, stopped: s }, actions: [{ kind: 'your-move', stop: s }] };
    };

    // What the PR shows resets what it answers: green ends the failure run, no conflict ends the rebase, a blocker ends the merge ask.
    const failing = failingOf(pr);
    if (failing.length === 0 && !isPending(pr) && next.attempts !== 0) next = { ...next, attempts: 0 };
    if (pr.mergeable !== false && next.rebased) {
        const { rebased: _r, ...rest } = next;
        next = rest;
    }
    const green = pullBlockers(pr).length === 0 && pr.review.state === 'approved';
    if (!green && next.mergeAsked) {
        const { mergeAsked: _m, ...rest } = next;
        next = rest;
    }

    if (next.turn) {
        if (turnHolds(next.turn, pr, now)) return { run: next, actions: [] };
        const { turn: _t, ...rest } = next;
        next = rest;
    }

    /** Start a turn; `taken` (the attempt, the threads, the rebase) is recorded only when the turn can start. */
    const turn = (kind: AutopilotTurnKind, text: string, taken: Partial<AutopilotRun>, extra: Partial<AutopilotTurn> = {}): AutopilotStep => {
        if (pr.chatId === undefined) return stop('no-chat', `Autopilot has no chat to work in for #${pr.number}.`);
        return {
            run: { ...next, ...taken, turn: { kind, startedAt: now, ...extra } },
            actions: [{ kind: 'turn', turn: kind, agentId: pilot.agentId, chatId: pr.chatId, ...(pr.taskId !== undefined ? { taskId: pr.taskId } : {}), text }]
        };
    };

    if (pr.mergeable === false) {
        if (!pilot.rebase) return { run: next, actions: [] };
        if (next.rebased) return stop('conflicts', `#${pr.number} still conflicts with ${pr.base} after a rebase — resolve the conflicts.`);
        return turn('rebase', rebaseText(pr), { rebased: true });
    }

    if (failing.length && !isPending(pr)) {
        if (!pilot.fixChecks) return { run: next, actions: [] };
        const max = attemptsOf(pilot);
        if (next.attempts >= max) {
            return stop('gave-up', `Gave up on ${failing.map((c) => c.name).join(', ')} after ${max} ${max === 1 ? 'attempt' : 'attempts'} — your move.`);
        }
        const attempt = next.attempts + 1;
        return turn('fix', fixText(pr, failing, attempt, max), { attempts: attempt }, { checks: failing.map((c) => c.name) });
    }

    // A running check blocks like a failing one: wait for CI before another turn.
    if (isPending(pr)) return { run: next, actions: [] };

    const threads = pilot.answerThreads ? newThreads(pilot, next, pr) : [];
    if (threads.length) {
        const ids = threads.map((t) => t.id);
        return turn('threads', threadsText(pr, threads), { answered: [...next.answered, ...ids] }, { threads: ids });
    }

    if (green && pilot.mergeWhenGreen && !next.mergeAsked) {
        return { run: { ...next, mergeAsked: true }, actions: [{ kind: 'merge', agentId: pilot.agentId, rule: ASK_ON_MERGE }] };
    }
    return { run: next, actions: [] };
}

/** The chat said the autopilot's turn ended: the PR now has `AUTOPILOT_SETTLE_MS` to show its effect. */
export function autopilotTurnEnded(run: AutopilotRun, now: number): AutopilotRun {
    return run.turn && run.turn.endedAt === undefined ? { ...run, turn: { ...run.turn, endedAt: now } } : run;
}

/** The merge's answer: merged, or declined (a refusal or an approver's no) — which stops it. */
export function autopilotMergeAnswered(run: AutopilotRun, pr: Pick<PullRequest, 'number'>, merged: boolean, now: number, reason?: string): AutopilotStep {
    if (merged) return { run, actions: [] };
    const stop: AutopilotStop = { reason: 'merge-declined', detail: `Merging #${pr.number} was declined${reason ? `: ${reason}` : ''} — your move.`, at: now };
    const { turn: _t, ...rest } = run;
    return { run: { ...rest, stopped: stop }, actions: [{ kind: 'your-move', stop }] };
}

/** `Take over`: the PR is yours; the autopilot keeps its switches but does nothing until resumed. */
export function takeOverAutopilot(run: AutopilotRun, now: number, by = 'you'): AutopilotRun {
    const { turn: _t, ...rest } = run;
    return { ...rest, stopped: { reason: 'taken-over', detail: `Taken over by ${by}.`, at: now } };
}

/** `Stop autopilot`: switched off; nothing runs until resumed. */
export function stopAutopilot(run: AutopilotRun): AutopilotRun {
    const { turn: _t, ...rest } = run;
    return { ...rest, off: true };
}

/** Back on the PR with a fresh attempt count; threads already taken up stay taken up. */
export function resumeAutopilot(run: AutopilotRun): AutopilotRun {
    return { attempts: 0, answered: run.answered };
}

// ---------------------------------------------------------------------------
// The "what is happening now" callout

/** One line for the callout (`Fixing size-limit · attempt 2 of 3`), or `undefined` when there is nothing to say. */
export function autopilotActivity(pilot: Autopilot | undefined, run: AutopilotRun, pr: PullRequest): string | undefined {
    if (!pilot) return undefined;
    if (run.off) return 'Autopilot is off';
    if (run.stopped) return run.stopped.detail;
    if (pr.state !== 'open') return undefined;
    const turn = run.turn;
    if (turn?.kind === 'fix') {
        const names = turn.checks ?? [];
        return `Fixing ${names.length === 1 ? names[0] : names.length ? `${names.length} failing checks` : 'a failing check'} · attempt ${run.attempts} of ${attemptsOf(pilot)}`;
    }
    if (turn?.kind === 'threads') {
        const n = turn.threads?.length ?? 0;
        return `Answering ${n === 1 ? '1 review thread' : `${n} review threads`}`;
    }
    if (turn?.kind === 'rebase') return `Rebasing onto ${pr.base}`;
    if (run.mergeAsked) return 'Asking to merge';
    return undefined;
}

/** The PR with its autopilot's `attempt` and `activity` filled from the run — what the PR page reads. */
export function withAutopilotRun(pr: PullRequest, run: AutopilotRun): PullRequest {
    const pilot = pr.autopilot;
    if (!pilot) return pr;
    const { attempt: _a, activity: _b, ...switches } = pilot;
    const activity = autopilotActivity(pilot, run, pr);
    return {
        ...pr,
        autopilot: {
            ...switches,
            ...(run.attempts > 0 && !run.off ? { attempt: run.attempts } : {}),
            ...(activity !== undefined ? { activity } : {})
        }
    };
}

// ---------------------------------------------------------------------------
// Taking the actions

/** What the autopilot acts through; the app wires it to the Chat/Router and the git feature's merge. */
export interface AutopilotPort {
    /**
     * Start a turn for `agentId` in `chatId` with `text` (on `taskId`, when the PR has one). May return the task the
     * turn runs as, kept on the run's turn so its end ends the turn (#858).
     */
    startTurn(turn: { readonly agentId: AgentId; readonly chatId: ChatId; readonly taskId?: TaskId; readonly text: string; readonly pr: PullRequest }): Promise<void | { readonly taskId?: TaskId }>;
    /** Merge through `rule` (the approval rule `ask on merge`): `merged`, or not with why. */
    merge(request: { readonly agentId: AgentId; readonly rule: ApprovalRule; readonly pr: PullRequest }): Promise<{ readonly merged: boolean; readonly reason?: string }>;
    /** It stopped: the next move is yours (#747 notifies). */
    yourMove?(event: { readonly pr: PullRequest; readonly stop: AutopilotStop }): Promise<void>;
}

/**
 * Step the PR and take the actions. A turn or merge that throws stops the autopilot (`gave-up` for a turn,
 * `merge-declined` for a merge) with the error's message — it never retries in a loop.
 */
export async function driveAutopilot(port: AutopilotPort, run: AutopilotRun, pr: PullRequest, now: number): Promise<AutopilotRun> {
    let step = stepAutopilot(pr.autopilot, run, pr, now);
    let out = step.run;
    for (const action of step.actions) {
        if (action.kind === 'turn') {
            try {
                const started = await port.startTurn({ agentId: action.agentId, chatId: action.chatId, ...(action.taskId !== undefined ? { taskId: action.taskId } : {}), text: action.text, pr });
                const taskId = started ? started.taskId : undefined;
                if (taskId !== undefined && out.turn) out = { ...out, turn: { ...out.turn, taskId } };
            } catch (error) {
                const stop: AutopilotStop = { reason: 'gave-up', detail: `Autopilot could not start a turn for #${pr.number}: ${messageOf(error)}`, at: now };
                // The turn never started: nothing it would have taken up counts as done.
                const { turn: _t, rebased: _r, ...rest } = out;
                out = { ...rest, attempts: run.attempts, answered: run.answered.filter((id) => rest.answered.includes(id)), ...(run.rebased ? { rebased: true } : {}), stopped: stop };
                await port.yourMove?.({ pr, stop }).catch(() => undefined);
            }
        } else if (action.kind === 'merge') {
            let answer: { merged: boolean; reason?: string };
            try {
                answer = await port.merge({ agentId: action.agentId, rule: action.rule, pr });
            } catch (error) {
                answer = { merged: false, reason: messageOf(error) };
            }
            step = autopilotMergeAnswered(out, pr, answer.merged, now, answer.reason);
            out = step.run;
            for (const a of step.actions) if (a.kind === 'your-move') await port.yourMove?.({ pr, stop: a.stop }).catch(() => undefined);
        } else {
            await port.yourMove?.({ pr, stop: action.stop }).catch(() => undefined);
        }
    }
    return out;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 300);
