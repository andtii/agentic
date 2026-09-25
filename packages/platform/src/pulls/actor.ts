/**
 * Pulls actor — `{ws}:pulls:{projectId}` (#742; PRJ-08, PRJ-10; architecture §10 "Projects (redesign)").
 *
 * One per project: the live state of the pull requests on the project's origin repo, polled through a
 * `PullSourcePort` from its own durable reminder (one-shot, re-armed each poll — never a `period`). While any
 * open PR has a check queued or running it polls every `POLL_FLOOR_MS`; otherwise the interval doubles on every
 * poll that changed nothing, up to `POLL_MAX_MS`, and drops back to the floor on any change. A failing source
 * backs off the same way; a `rate-limited` one waits until its `retryAt`.
 *
 * A PR is linked to its task, chat and session by its head branch (`linkBranch`, the branch `gitBranchFor`
 * gave the chat) or by the agent reporting it (`report`). A linked task waits `pull-request {number, state}`
 * while the PR is open, completes when it merges and fails when it is closed without merging. `pull.merged` and
 * `pull.closed` are audited once per PR.
 *
 * Autopilot (#820, PRJ-09): an open PR with switches keeps one `AutopilotRun`, driven after every good poll through
 * the app's `PullsAutopilotPort`; `setAutopilot`, `takeOver`, `stopAutopilot`, `resumeAutopilot`,
 * `autopilotTurnEnded` and `answerMerge` are the page's and the chat's hooks. The view carries each PR through
 * `withAutopilotRun`, so its `autopilot.attempt` and `activity` are the run's, and `runs` says where each run stands
 * (paused, asking to merge) for the page's Resume and Approve / Decline. A turn whose task the port named ends when
 * that task ends (#858): each poll reads the task — polling at the floor while such a turn runs — and ends the turn
 * (`AUTOPILOT_SETTLE_MS` from then) once the task is terminal or waits on a pull request.
 *
 * Your move (#818, PRJ-10): after every good poll, each PR whose next move became yours for a new reason
 * (`pullNotification` over the view before and after the poll) is one `input` row in the workspace's Inbox, sent
 * one-way after the save. A conflict a running autopilot rebases is left to it (it says so itself, `yourMove`, if the
 * rebase fails), and the first read of a repo (`watch` of a new one) sends nothing — no burst.
 *
 * Workers eviction rule: every mutation below ends in `ctx.save()` inside the turn.
 */
import { isTerminal, type AgentId, type ApprovalRule, type Autopilot, type ChatId, type PluginReadinessStatus, type ProjectId, type PullRequest, type SessionId, type TaskId, type WorkspaceId } from '@agentic/core';
import { defineActor, type ActorContext, type ActorPolicy, type AnyActorDefinition } from '@sigx/actors';
import { ServerFnError } from '@sigx/server';
import { auditPort, type AuditPort } from '../audit/port.js';
import { sameWorkspace } from '../auth/index.js';
import { TaskActor } from '../task/actor.js';
import { taskKey } from '../task/key.js';
import { parsePullsKey, PULLS_TYPE } from './key.js';
import type { PullSource, PullSourcePort } from './ports.js';
import {
    ASK_ON_MERGE,
    autopilotMergeAnswered,
    autopilotTurnEnded,
    driveAutopilot,
    NEW_AUTOPILOT_RUN,
    resumeAutopilot,
    stopAutopilot,
    takeOverAutopilot,
    withAutopilotRun,
    type AutopilotPort,
    type AutopilotRun,
    type AutopilotStopReason
} from './autopilot.js';
import type { PullsAutopilotPort } from './autopilot-port.js';
import { notifyPull, pullMove } from './notify.js';
import type { TriggerHop } from '../schedule/ports.js';

// ---------------------------------------------------------------------------
// State

/** What a PR is linked to: the task it completes, the chat and session it came from. */
export interface PullLink {
    readonly taskId?: TaskId;
    readonly chatId?: ChatId;
    readonly sessionId?: SessionId;
}

/** The repo the project's origin names. */
export interface PullsRepo {
    /** The adapter id (`github`). */
    readonly provider: string;
    /** `owner/name`. */
    readonly repo: string;
}

interface TrackedPull {
    pr: PullRequest;
    /** `pull.merged` / `pull.closed` recorded. */
    audited?: boolean;
    /** The task this PR's end was already applied to. */
    taskDone?: TaskId;
    /** The autopilot's run on this PR (#820), while it has switches. */
    autopilot?: AutopilotRun;
    /** A merge the autopilot asked you for, until `answerMerge` (or the PR stops being green). */
    mergeAsk?: { readonly agentId: AgentId; readonly at: number };
}

export interface PullsState {
    workspaceId: WorkspaceId;
    projectId: ProjectId;
    repo?: PullsRepo;
    /** By PR number. */
    pulls: Record<string, TrackedPull>;
    /** Head branch → link, applied to every PR on that branch that has none. */
    branches: Record<string, PullLink>;
    /** PR number → link the agent reported, until the PR is read. */
    reported: Record<string, PullLink>;
    /** The current idle interval, ms. */
    intervalMs: number;
    polledAt?: number;
    /** When the next poll is armed for; absent when nothing is armed. */
    next?: number;
    /** Why the last poll failed; absent after a good one. */
    error?: string;
    /** Set when the last poll found no credential for the repo (#840); absent after a good one. */
    readiness?: PullsReadiness;
}

/** Where a PR's autopilot run stands (#858): what the page's Resume and Approve / Decline follow. */
export interface PullAutopilotState {
    /** Switched off (`off`, Stop autopilot) or why it stopped; absent while it runs. `resumeAutopilot` clears it. */
    readonly paused?: 'off' | AutopilotStopReason;
    /** A merge the autopilot asked for waits on your answer (`answerMerge`). */
    readonly askingMerge?: true;
}

/** What `get()` returns: the PRs newest first, and how the polling stands. */
export interface PullsView {
    readonly workspaceId: WorkspaceId;
    readonly projectId: ProjectId;
    readonly repo?: PullsRepo;
    readonly pulls: readonly PullRequest[];
    /** By PR number: where each switched-on PR's autopilot run stands (#858). */
    readonly runs: Readonly<Record<string, PullAutopilotState>>;
    readonly polledAt?: number;
    readonly next?: number;
    readonly error?: string;
    /** `needs-sign-in`: the last poll found no credential for the repo (#840) — the project needs a GitHub connector or token. */
    readonly readiness?: PullsReadiness;
}

/** Why the actor cannot read: only a missing credential, so far (#840). */
export type PullsReadiness = Extract<PluginReadinessStatus, 'needs-sign-in'>;

/** The error a poll records when there is no source (no adapter or credential) for the repo. */
export class NoPullSourceError extends Error {
    constructor(provider: string, repo: string) {
        super(`no ${provider} pull request source for ${repo} (no adapter or credential)`);
        this.name = 'NoPullSourceError';
    }
}

// ---------------------------------------------------------------------------
// Options

/** What happens when a PR is first seen merged (#868; production: the merge notices to requesters, `pullMergeNotices`). */
export interface PullMergedPort {
    merged(hop: TriggerHop, event: { readonly workspaceId: WorkspaceId; readonly projectId: ProjectId; readonly pr: PullRequest }): Promise<void>;
}

export interface PullsActorOptions {
    /** Where the PRs are read. */
    readonly sources: PullSourcePort;
    /** Clock; default `Date.now`. */
    readonly now?: () => number;
    /** Override the policy chain. Default: the package's `sameWorkspace`. */
    readonly authorize?: ActorPolicy | readonly ActorPolicy[];
    /** Waive the identity gate (tests). */
    readonly allowAnonymous?: true;
    /** Where `pull.merged` / `pull.closed` go. Default: the workspace's Audit log. */
    readonly audit?: AuditPort;
    /**
     * What the autopilot acts through, per workspace (#820): turns in the PR's chat, the merge, your-move rows. Absent
     * → the switches are kept and shown, but nothing is driven.
     */
    readonly autopilot?: (ref: { readonly workspaceId: WorkspaceId; readonly projectId: ProjectId }) => PullsAutopilotPort;
    /** Told once per PR, when its merge is recorded and before its task completes. Never a gate: a throw is logged. */
    readonly merged?: PullMergedPort;
    /** The workspace's Inbox (`defineInbox`), where a PR that became your move is told (#818). Absent → nothing is sent. */
    readonly inbox?: () => AnyActorDefinition;
}

/** The switches `setAutopilot` takes: core's `Autopilot` without what the run fills. */
export type AutopilotSwitches = Omit<Autopilot, 'attempt' | 'activity'>;
/** The most fix attempts a PR's autopilot may be given. */
export const AUTOPILOT_MAX_ATTEMPTS = 10;

function checkSwitches(pilot: AutopilotSwitches): AutopilotSwitches {
    if (!pilot || typeof pilot !== 'object') throw new ServerFnError(400, '[pulls] autopilot must be an object');
    if (typeof pilot.agentId !== 'string' || !pilot.agentId.trim() || pilot.agentId.length > 200) throw new ServerFnError(400, '[pulls] autopilot.agentId must be an agent id');
    for (const k of ['fixChecks', 'answerThreads', 'rebase', 'mergeWhenGreen'] as const) {
        if (typeof pilot[k] !== 'boolean') throw new ServerFnError(400, `[pulls] autopilot.${k} must be a boolean`);
    }
    if (!Number.isSafeInteger(pilot.maxAttempts) || pilot.maxAttempts < 1 || pilot.maxAttempts > AUTOPILOT_MAX_ATTEMPTS) {
        throw new ServerFnError(400, `[pulls] autopilot.maxAttempts must be 1..${AUTOPILOT_MAX_ATTEMPTS}`);
    }
    return { agentId: pilot.agentId, fixChecks: pilot.fixChecks, maxAttempts: pilot.maxAttempts, answerThreads: pilot.answerThreads, rebase: pilot.rebase, mergeWhenGreen: pilot.mergeWhenGreen };
}

/** The reminder every poll is armed under. */
export const PULLS_POLL = 'poll';
/** The platform's reminder resolution, and the interval while a check runs. */
export const POLL_FLOOR_MS = 60_000;
/** The longest idle interval. */
export const POLL_MAX_MS = 15 * 60_000;
/** Settled (merged or closed) PRs kept on the view, newest first. */
export const SETTLED_PULLS_KEPT = 50;
/** Branch links kept; the oldest go first. */
export const BRANCH_LINKS_KEPT = 200;
/** Who the actor's own transitions and records are by. */
export const PULLS_BY = 'system:pulls';

const PROVIDER_RE = /^[a-z0-9][a-z0-9-]*$/;
const REPO_SEGMENT = /^[A-Za-z0-9_.-]+$/;
const isRepo = (repo: string): boolean => {
    const parts = repo.split('/');
    return parts.length === 2 && parts.every((p) => REPO_SEGMENT.test(p) && p !== '.' && p !== '..');
};

function checkLink(link: PullLink): PullLink {
    if (!link || typeof link !== 'object') throw new ServerFnError(400, '[pulls] a link must be an object');
    const out: { taskId?: TaskId; chatId?: ChatId; sessionId?: SessionId } = {};
    for (const k of ['taskId', 'chatId', 'sessionId'] as const) {
        const v = link[k];
        if (v === undefined) continue;
        if (typeof v !== 'string' || !v.trim() || v.length > 200) throw new ServerFnError(400, `[pulls] link.${k} must be an id`);
        (out as Record<string, string>)[k] = v;
    }
    if (!Object.keys(out).length) throw new ServerFnError(400, '[pulls] a link names a taskId, chatId or sessionId');
    return out;
}

const linkOf = (pr: PullRequest | undefined): PullLink => ({
    ...(pr?.taskId !== undefined ? { taskId: pr.taskId } : {}),
    ...(pr?.chatId !== undefined ? { chatId: pr.chatId } : {}),
    ...(pr?.sessionId !== undefined ? { sessionId: pr.sessionId } : {})
});

/** A rate-limit refusal's retry instant — the adapter's `PullProviderError {code: 'rate-limited', retryAt}`. */
function retryAtOf(error: unknown): number | undefined {
    const e = error as { code?: unknown; retryAt?: unknown } | null;
    return e && e.code === 'rate-limited' && typeof e.retryAt === 'number' ? e.retryAt : undefined;
}

// ---------------------------------------------------------------------------
// Definition

export function definePullsActor(options: PullsActorOptions) {
    const now = options.now ?? Date.now;
    const audit = options.audit ?? auditPort();
    const authorize: ActorPolicy | readonly ActorPolicy[] = options.authorize ?? sameWorkspace;

    type Ctx = ActorContext<PullsState>;

    const runStateOf = (t: TrackedPull): PullAutopilotState => {
        const run = t.autopilot;
        const paused = run?.off ? 'off' : run?.stopped?.reason;
        return { ...(paused ? { paused } : {}), ...(t.mergeAsk && t.pr.state === 'open' ? { askingMerge: true as const } : {}) };
    };

    /** A PR as the view shows it: with its autopilot run's attempt and activity. */
    const shown = (t: TrackedPull): PullRequest => (t.autopilot ? withAutopilotRun(t.pr, t.autopilot) : t.pr);

    const view = (s: PullsState): PullsView => ({
        workspaceId: s.workspaceId,
        projectId: s.projectId,
        ...(s.repo ? { repo: { ...s.repo } } : {}),
        pulls: Object.values(s.pulls)
            .map(shown)
            .sort((a, b) => b.number - a.number),
        runs: Object.fromEntries(Object.values(s.pulls).filter((t) => t.pr.autopilot).map((t) => [String(t.pr.number), runStateOf(t)])),
        ...(s.polledAt !== undefined ? { polledAt: s.polledAt } : {}),
        ...(s.next !== undefined ? { next: s.next } : {}),
        ...(s.error !== undefined ? { error: s.error } : {}),
        ...(s.readiness !== undefined ? { readiness: s.readiness } : {})
    });

    /** Fold a fresh read into the tracked PR: the provider's facts, our links and what only we know. Returns whether it changed. */
    const upsert = (s: PullsState, fresh: PullRequest): boolean => {
        const id = String(fresh.number);
        const old = s.pulls[id];
        const link: PullLink = { ...s.branches[fresh.head], ...linkOf(old?.pr), ...s.reported[id] };
        const next: PullRequest = {
            ...fresh,
            ...(fresh.autopilot === undefined && old?.pr.autopilot ? { autopilot: old.pr.autopilot } : {}),
            ...(fresh.after === undefined && old?.pr.after !== undefined ? { after: old.pr.after } : {}),
            ...link
        };
        delete s.reported[id];
        const changed = !old || JSON.stringify(old.pr) !== JSON.stringify(next);
        s.pulls[id] = { ...old, pr: next };
        return changed;
    };

    /** Keep every open PR and the newest settled ones. */
    const prune = (s: PullsState): void => {
        const settled = Object.values(s.pulls)
            .filter((t) => t.pr.state !== 'open')
            .sort((a, b) => b.pr.number - a.pr.number);
        for (const t of settled.slice(SETTLED_PULLS_KEPT)) delete s.pulls[String(t.pr.number)];
    };

    /** The linked task follows its PR: waits while it is open, completes on merge, fails on close. */
    const followTask = async (ctx: Ctx, t: TrackedPull): Promise<void> => {
        const { pr } = t;
        const taskId = pr.taskId;
        if (taskId === undefined || t.taskDone === taskId) return;
        const task = ctx.actor(TaskActor, taskKey(ctx.state.workspaceId, taskId));
        const view = await task.get().catch(() => undefined);
        if (!view || isTerminal(view.status)) {
            t.taskDone = taskId;
            return;
        }
        const waitsOnIt = view.status === 'waiting' && view.wait?.kind === 'pull-request' && view.wait.number === pr.number;
        try {
            if (pr.state === 'open') {
                if (view.status === 'queued' || view.status === 'active') await task.reportWaiting({ kind: 'pull-request', number: pr.number, state: 'open' }, PULLS_BY, view.sessionId);
                return;
            }
            if (waitsOnIt && pr.state === 'merged') {
                await task.resolveWaiting(PULLS_BY, `pull request #${pr.number} merged`);
                await task.complete({ text: `Pull request #${pr.number} merged: ${pr.title}`, artifacts: [], verified: true }, PULLS_BY);
            } else if (waitsOnIt) {
                await task.fail({ code: 'pull-closed', message: `Pull request #${pr.number} was closed without merging.`, recoverable: true }, PULLS_BY);
            }
        } catch {
            // The task moved meanwhile (cancelled, settled): its record stands. An open PR is looked at again next poll.
            if (pr.state === 'open') return;
        }
        // Settled once: a task that was not waiting on it (still active) is completed by its own turn's end.
        t.taskDone = taskId;
    };

    /** `pull.merged` / `pull.closed`, once per PR. */
    const record = async (ctx: Ctx, t: TrackedPull): Promise<void> => {
        const { pr } = t;
        if (pr.state === 'open' || t.audited) return;
        const s = ctx.state;
        const kind = pr.state === 'merged' ? 'pull.merged' : 'pull.closed';
        const at = pr.state === 'merged' ? (pr.mergedAt ?? now()) : now();
        await audit.record(ctx, s.workspaceId, {
            key: `${ctx.key}:${pr.number}:${pr.state}`,
            kind,
            at,
            by: PULLS_BY,
            summary: `pull request #${pr.number} ${pr.state === 'merged' ? 'merged' : 'closed without merging'}: ${pr.title}`,
            ...(pr.taskId !== undefined ? { taskId: pr.taskId } : {}),
            ...(pr.sessionId !== undefined ? { sessionId: pr.sessionId } : {}),
            data: {
                projectId: s.projectId,
                provider: pr.provider,
                repo: pr.repo,
                number: pr.number,
                title: pr.title,
                url: pr.url,
                head: pr.head,
                base: pr.base,
                ...(pr.taskId !== undefined ? { taskId: pr.taskId } : {}),
                ...(pr.chatId !== undefined ? { chatId: pr.chatId } : {})
            }
        });
        t.audited = true;
    };

    /** The merge hook, once per PR (it rides on the audit's once): a failure is logged, never retried. */
    const noticeMerge = async (ctx: Ctx, pr: PullRequest): Promise<void> => {
        if (!options.merged) return;
        try {
            await options.merged.merged({ actor: (def, key) => ctx.actor(def, key) }, { workspaceId: ctx.state.workspaceId, projectId: ctx.state.projectId, pr });
        } catch (error) {
            console.warn(`[pulls] merge notices for #${pr.number} failed:`, error);
        }
    };

    /** An autopilot turn whose task is known and has not ended yet: its task is read every poll. */
    const turnRuns = (t: TrackedPull): boolean => {
        const turn = t.autopilot?.turn;
        return t.pr.state === 'open' && turn?.taskId !== undefined && turn.endedAt === undefined;
    };

    /** The turn's task ended (terminal, or waiting on a pull request): the turn ended (#858). */
    const endTurn = async (ctx: Ctx, t: TrackedPull): Promise<void> => {
        const taskId = t.autopilot?.turn?.taskId;
        if (!t.autopilot || taskId === undefined || t.autopilot.turn?.endedAt !== undefined) return;
        // A PR merged or closed mid-turn ends the turn: nothing reads its task again once the PR is not open.
        if (t.pr.state !== 'open') {
            t.autopilot = autopilotTurnEnded(t.autopilot, now());
            return;
        }
        const task = await ctx.actor(TaskActor, taskKey(ctx.state.workspaceId, taskId)).get().catch(() => undefined);
        // An unreadable task leaves the turn to `AUTOPILOT_TURN_STALE_MS`.
        if (!task) return;
        if (isTerminal(task.status) || (task.status === 'waiting' && task.wait?.kind === 'pull-request')) t.autopilot = autopilotTurnEnded(t.autopilot, now());
    };

    const portFor = (s: PullsState): PullsAutopilotPort | undefined => options.autopilot?.({ workspaceId: s.workspaceId, projectId: s.projectId });

    /**
     * Step the PR's autopilot and take its actions (#820). A merge whose rule says `ask` is not taken: it is recorded
     * as `mergeAsk`, told to you (`askMerge`) and waits for `answerMerge`; `deny` declines it; `allow` merges.
     */
    const drive = async (s: PullsState, t: TrackedPull): Promise<void> => {
        const port = portFor(s);
        if (!port || !t.pr.autopilot) return;
        if (t.pr.state !== 'open') {
            delete t.mergeAsk;
            return;
        }
        const run = t.autopilot ?? NEW_AUTOPILOT_RUN;
        let asked: { agentId: AgentId; rule: ApprovalRule } | undefined;
        const gate: AutopilotPort = {
            startTurn: (turn) => port.startTurn(turn),
            merge: async (request) => {
                if (request.rule.outcome === 'ask') {
                    asked = { agentId: request.agentId, rule: request.rule };
                    return { merged: false };
                }
                if (request.rule.outcome === 'deny') return { merged: false, reason: `the approval rule ${request.rule.id} denies it` };
                return port.merge(request);
            },
            yourMove: async (event) => {
                if (asked && event.stop.reason === 'merge-declined') return;
                await port.yourMove?.(event);
            }
        };
        let out = await driveAutopilot(gate, run, t.pr, now());
        if (asked) {
            // Not declined: asked. The run keeps `mergeAsked` (one ask per green run) and waits for the answer.
            const { stopped: _s, ...rest } = out;
            out = rest;
            t.mergeAsk = { agentId: asked.agentId, at: now() };
            await port.askMerge?.({ agentId: asked.agentId, rule: asked.rule, pr: t.pr }).catch(() => undefined);
        }
        if (!out.mergeAsked) delete t.mergeAsk;
        t.autopilot = out;
    };

    /**
     * Tell the Inbox about each PR whose move became yours since `before` (#818). A PR not in `before` is new to us
     * (`prev` undefined) unless `baseline`. A conflict a running autopilot rebases is its own to report.
     */
    const notifyMoves = async (ctx: Ctx, before: ReadonlyMap<number, PullRequest>, baseline: boolean): Promise<void> => {
        if (!options.inbox || baseline) return;
        const driven = portFor(ctx.state) !== undefined;
        for (const t of Object.values(ctx.state.pulls)) {
            const next = shown(t);
            // A running autopilot rebases a conflict itself and says so if it cannot (`yourMove`); a stopped run's
            // `activity` already keeps `pullMove` from a second `gave-up`.
            const rebasing = driven && next.autopilot?.rebase && !t.autopilot?.off && !t.autopilot?.stopped;
            if (rebasing && pullMove(next) === 'conflicts') continue;
            await notifyPull(ctx, options.inbox, ctx.state.workspaceId, before.get(t.pr.number), next);
        }
    };

    /**
     * Read the source, fold, follow the tasks, arm the next poll — all inside this turn; then tell the Inbox what became
     * your move. `baseline`: the first read of a repo, which notifies nothing.
     */
    const poll = async (ctx: Ctx, baseline = false): Promise<void> => {
        const s = ctx.state;
        const at = now();
        const before = new Map(Object.values(s.pulls).map((t) => [t.pr.number, shown(t)] as const));
        if (!s.repo) {
            delete s.next;
            await ctx.save();
            await ctx.reminders.clear(PULLS_POLL);
            return;
        }
        const { provider, repo } = s.repo;
        let changed = false;
        let delay: number;
        try {
            const source: PullSource | undefined = await options.sources.open({ workspaceId: s.workspaceId, projectId: s.projectId, provider, repo });
            if (!source) throw new NoPullSourceError(provider, repo);
            const seen = new Map<number, PullRequest>();
            for (const pr of await source.listOpen(repo)) if (pr.repo === repo) seen.set(pr.number, pr);
            // An open PR that left the list merged or closed; a reported one may never have been open to us.
            const ask = new Set<number>();
            for (const t of Object.values(s.pulls)) if (t.pr.state === 'open' && !seen.has(t.pr.number)) ask.add(t.pr.number);
            for (const n of Object.keys(s.reported)) if (!seen.has(Number(n)) && !s.pulls[n]) ask.add(Number(n));
            for (const n of ask) {
                const pr = await source.get(repo, n);
                if (pr) seen.set(n, pr);
                else if (s.reported[String(n)]) {
                    // The agent named a PR the repo does not have: its task must not wait on it forever.
                    const link = s.reported[String(n)]!;
                    delete s.reported[String(n)];
                    changed = true;
                    if (link.taskId !== undefined) await failMissing(ctx, link.taskId, n);
                }
            }
            for (const pr of seen.values()) if (upsert(s, pr)) changed = true;
            if (s.error !== undefined || s.readiness !== undefined) changed = true;
            delete s.error;
            delete s.readiness;
            const running = Object.values(s.pulls).some((t) => t.pr.state === 'open' && t.pr.checks.some((c) => c.state === 'queued' || c.state === 'running'));
            s.intervalMs = running || changed ? POLL_FLOOR_MS : Math.min(POLL_MAX_MS, s.intervalMs * 2);
            delay = s.intervalMs;
        } catch (error) {
            s.error = (error instanceof Error ? error.message : String(error)).slice(0, 500);
            if (error instanceof NoPullSourceError) s.readiness = 'needs-sign-in';
            else delete s.readiness;
            s.intervalMs = Math.min(POLL_MAX_MS, s.intervalMs * 2);
            const retryAt = retryAtOf(error);
            delay = retryAt !== undefined ? Math.max(POLL_FLOOR_MS, retryAt - at) : s.intervalMs;
        }
        for (const t of Object.values(s.pulls)) {
            const merging = t.pr.state === 'merged' && !t.audited;
            await record(ctx, t);
            if (merging) await noticeMerge(ctx, t.pr);
            await followTask(ctx, t);
        }
        // Only on a good read: the autopilot acts on what the PR shows now, never on a stale view.
        if (s.error === undefined) {
            for (const t of Object.values(s.pulls)) {
                try {
                    await endTurn(ctx, t);
                    await drive(s, t);
                } catch (error) {
                    console.warn(`[pulls] autopilot on #${t.pr.number} failed:`, error);
                }
            }
        }
        // A running turn's end is read on the next poll: keep that at the floor.
        if (s.error === undefined && Object.values(s.pulls).some(turnRuns)) {
            s.intervalMs = POLL_FLOOR_MS;
            delay = Math.min(delay, POLL_FLOOR_MS);
        }
        prune(s);
        s.polledAt = at;
        s.next = at + delay;
        await ctx.save();
        await ctx.reminders.set(PULLS_POLL, { due: delay });
        if (s.error === undefined) await notifyMoves(ctx, before, baseline);
    };

    const failMissing = async (ctx: Ctx, taskId: TaskId, number: number): Promise<void> => {
        const task = ctx.actor(TaskActor, taskKey(ctx.state.workspaceId, taskId));
        const view = await task.get().catch(() => undefined);
        if (view?.status !== 'waiting' || view.wait?.kind !== 'pull-request' || view.wait.number !== number) return;
        await task.fail({ code: 'pull-missing', message: `Pull request #${number} does not exist in ${ctx.state.repo?.repo ?? 'the repo'}.`, recoverable: true }, PULLS_BY).catch(() => undefined);
    };

    return defineActor({
        type: PULLS_TYPE,
        authorize,
        ...(options.allowAnonymous ? { allowAnonymous: true as const } : {}),
        state: (key): PullsState => {
            // A malformed key is refused by the methods, not here: a throwing factory is an opaque activation failure.
            const parsed = parsePullsKey(key);
            return {
                workspaceId: parsed?.workspaceId ?? ('' as WorkspaceId),
                projectId: parsed?.projectId ?? ('' as ProjectId),
                pulls: {},
                branches: {},
                reported: {},
                intervalMs: POLL_FLOOR_MS
            };
        },
        methods: (ctx) => {
            const requireKey = (): void => {
                if (parsePullsKey(ctx.key) === null) throw new ServerFnError(400, `[pulls] key must be "{ws}:pulls:{projectId}", got "${ctx.key}"`);
            };
            const trackedOf = (number: number): TrackedPull => {
                requireKey();
                if (!Number.isSafeInteger(number) || number <= 0) throw new ServerFnError(400, '[pulls] number must be a PR number');
                const t = ctx.state.pulls[String(number)];
                if (!t) throw new ServerFnError(404, `[pulls] #${number} is not tracked`);
                return t;
            };
            /** Save the change; with `pollNow`, read (and drive) at once on the next reminder. */
            const settle = async (pollNow = true): Promise<PullsView> => {
                await ctx.save();
                if (pollNow && ctx.state.repo) await ctx.reminders.set(PULLS_POLL, { due: 0 });
                return view(ctx.state);
            };
            return {
                /** Track the repo the project's origin names (plugins-git `pullRepoOf`) and poll it now. Another repo starts over. */
                async watch(ref: PullsRepo): Promise<PullsView> {
                    requireKey();
                    if (!ref || typeof ref.provider !== 'string' || !PROVIDER_RE.test(ref.provider)) throw new ServerFnError(400, '[pulls] provider must be an adapter id');
                    if (typeof ref.repo !== 'string' || !isRepo(ref.repo)) throw new ServerFnError(400, '[pulls] repo must be owner/name');
                    const s = ctx.state;
                    const fresh = s.repo?.provider !== ref.provider || s.repo.repo !== ref.repo;
                    if (fresh) {
                        s.pulls = {};
                        delete s.error;
                        delete s.readiness;
                    }
                    s.repo = { provider: ref.provider, repo: ref.repo };
                    s.intervalMs = POLL_FLOOR_MS;
                    // A new repo's first read is the baseline: its PRs already red are not a burst of rows.
                    await poll(ctx, fresh);
                    return view(s);
                },

                /** Stop polling; the PRs already read stay on the view. */
                async unwatch(): Promise<PullsView> {
                    requireKey();
                    delete ctx.state.repo;
                    await poll(ctx);
                    return view(ctx.state);
                },

                /** Link every PR whose head is `branch` (the chat's `gitBranchFor`) to `link`; read on the next poll. */
                async linkBranch(branch: string, link: PullLink): Promise<PullsView> {
                    requireKey();
                    if (typeof branch !== 'string' || !branch.trim() || branch.length > 255) throw new ServerFnError(400, '[pulls] branch must be a branch name');
                    const s = ctx.state;
                    delete s.branches[branch];
                    s.branches[branch] = checkLink(link);
                    const names = Object.keys(s.branches);
                    for (const name of names.slice(0, Math.max(0, names.length - BRANCH_LINKS_KEPT))) delete s.branches[name];
                    await ctx.save();
                    if (s.repo) await ctx.reminders.set(PULLS_POLL, { due: 0 });
                    return view(s);
                },

                /**
                 * The agent's word that it opened PR `number` for `link`: its task waits on the PR from now on, and the PR is
                 * read at once. A number the repo does not have fails the task (`pull-missing`) instead of waiting forever.
                 */
                async report(number: number, link: PullLink): Promise<PullsView> {
                    requireKey();
                    if (!Number.isSafeInteger(number) || number <= 0) throw new ServerFnError(400, '[pulls] number must be a PR number');
                    const checked = checkLink(link);
                    const s = ctx.state;
                    const tracked = s.pulls[String(number)];
                    if (tracked) {
                        tracked.pr = { ...tracked.pr, ...checked };
                        if (checked.taskId !== undefined && checked.taskId !== tracked.taskDone) delete tracked.taskDone;
                    } else s.reported[String(number)] = checked;
                    // Wait before the turn that opened it ends, so its end does not complete the task first.
                    if (checked.taskId !== undefined && (!tracked || tracked.pr.state === 'open')) {
                        const task = ctx.actor(TaskActor, taskKey(s.workspaceId, checked.taskId));
                        const t = await task.get().catch(() => undefined);
                        if (t && (t.status === 'queued' || t.status === 'active')) {
                            await task.reportWaiting({ kind: 'pull-request', number, state: 'open' }, PULLS_BY, t.sessionId).catch(() => undefined);
                        }
                    }
                    s.intervalMs = POLL_FLOOR_MS;
                    await poll(ctx);
                    return view(s);
                },

                /**
                 * Switch the PR's autopilot on with `switches`, or off for good with `null` (#820). A run that was
                 * stopped or switched off starts again; the PR is read and driven at once.
                 */
                async setAutopilot(number: number, switches: AutopilotSwitches | null): Promise<PullsView> {
                    const t = trackedOf(number);
                    if (switches === null) {
                        const { autopilot: _a, ...pr } = t.pr;
                        t.pr = pr;
                        delete t.autopilot;
                        delete t.mergeAsk;
                    } else {
                        t.pr = { ...t.pr, autopilot: checkSwitches(switches) };
                        if (t.autopilot && (t.autopilot.off || t.autopilot.stopped)) t.autopilot = resumeAutopilot(t.autopilot);
                    }
                    return settle();
                },

                /** `Take over`: the PR is yours; the autopilot keeps its switches and does nothing until resumed. */
                async takeOver(number: number): Promise<PullsView> {
                    const t = trackedOf(number);
                    t.autopilot = takeOverAutopilot(t.autopilot ?? NEW_AUTOPILOT_RUN, now());
                    delete t.mergeAsk;
                    return settle(false);
                },

                /** `Stop autopilot`: switched off until resumed. */
                async stopAutopilot(number: number): Promise<PullsView> {
                    const t = trackedOf(number);
                    t.autopilot = stopAutopilot(t.autopilot ?? NEW_AUTOPILOT_RUN);
                    delete t.mergeAsk;
                    return settle(false);
                },

                /** Back on the PR with a fresh attempt count; read and driven at once. */
                async resumeAutopilot(number: number): Promise<PullsView> {
                    const t = trackedOf(number);
                    t.autopilot = resumeAutopilot(t.autopilot ?? NEW_AUTOPILOT_RUN);
                    return settle();
                },

                /** The PR's chat says the autopilot's turn ended: the PR now has `AUTOPILOT_SETTLE_MS` to show its effect. */
                async autopilotTurnEnded(number: number): Promise<PullsView> {
                    const t = trackedOf(number);
                    if (t.autopilot) t.autopilot = autopilotTurnEnded(t.autopilot, now());
                    return settle(false);
                },

                /**
                 * Your answer to the merge the autopilot asked for (`ask on merge`): approved, it merges through the
                 * app's port and the PR is read at once; declined (or refused by the provider), the autopilot stops.
                 */
                async answerMerge(number: number, approve: boolean): Promise<PullsView> {
                    const t = trackedOf(number);
                    if (typeof approve !== 'boolean') throw new ServerFnError(400, '[pulls] approve must be a boolean');
                    const ask = t.mergeAsk;
                    if (!ask || t.pr.state !== 'open') throw new ServerFnError(409, `[pulls] #${number} has no merge waiting for an answer`);
                    delete t.mergeAsk;
                    const run = t.autopilot ?? NEW_AUTOPILOT_RUN;
                    let answer: { merged: boolean; reason?: string } = { merged: false, reason: 'you declined it' };
                    if (approve) {
                        const port = portFor(ctx.state);
                        try {
                            answer = port ? await port.merge({ agentId: ask.agentId, rule: ASK_ON_MERGE, pr: t.pr }) : { merged: false, reason: 'no merge is wired on this deployment' };
                        } catch (error) {
                            answer = { merged: false, reason: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
                        }
                    }
                    t.autopilot = autopilotMergeAnswered(run, t.pr, answer.merged, now(), answer.reason).run;
                    return settle(answer.merged);
                },

                /** Poll now. */
                async poll(): Promise<PullsView> {
                    requireKey();
                    await poll(ctx);
                    return view(ctx.state);
                },

                async get(): Promise<PullsView> {
                    requireKey();
                    return view(ctx.state);
                }
            };
        },

        onReminder: async (ctx, name) => {
            if (name !== PULLS_POLL) return;
            await poll(ctx);
        }
    });
}

export type PullsActor = ReturnType<typeof definePullsActor>;
