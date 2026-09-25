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
 * Workers eviction rule: every mutation below ends in `ctx.save()` inside the turn.
 */
import { isTerminal, type ChatId, type ProjectId, type PullRequest, type SessionId, type TaskId, type WorkspaceId } from '@agentic/core';
import { defineActor, type ActorContext, type ActorPolicy } from '@sigx/actors';
import { ServerFnError } from '@sigx/server';
import { auditPort, type AuditPort } from '../audit/port.js';
import { sameWorkspace } from '../auth/index.js';
import { TaskActor } from '../task/actor.js';
import { taskKey } from '../task/key.js';
import { parsePullsKey, PULLS_TYPE } from './key.js';
import type { PullSource, PullSourcePort } from './ports.js';

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
}

/** What `get()` returns: the PRs newest first, and how the polling stands. */
export interface PullsView {
    readonly workspaceId: WorkspaceId;
    readonly projectId: ProjectId;
    readonly repo?: PullsRepo;
    readonly pulls: readonly PullRequest[];
    readonly polledAt?: number;
    readonly next?: number;
    readonly error?: string;
}

// ---------------------------------------------------------------------------
// Options

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

    const view = (s: PullsState): PullsView => ({
        workspaceId: s.workspaceId,
        projectId: s.projectId,
        ...(s.repo ? { repo: { ...s.repo } } : {}),
        pulls: Object.values(s.pulls)
            .map((t) => t.pr)
            .sort((a, b) => b.number - a.number),
        ...(s.polledAt !== undefined ? { polledAt: s.polledAt } : {}),
        ...(s.next !== undefined ? { next: s.next } : {}),
        ...(s.error !== undefined ? { error: s.error } : {})
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

    /** Read the source, fold, follow the tasks, arm the next poll — all inside this turn. */
    const poll = async (ctx: Ctx): Promise<void> => {
        const s = ctx.state;
        const at = now();
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
            if (!source) throw new Error(`no ${provider} pull request source for ${repo} (no adapter or credential)`);
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
            if (s.error !== undefined) changed = true;
            delete s.error;
            const running = Object.values(s.pulls).some((t) => t.pr.state === 'open' && t.pr.checks.some((c) => c.state === 'queued' || c.state === 'running'));
            s.intervalMs = running || changed ? POLL_FLOOR_MS : Math.min(POLL_MAX_MS, s.intervalMs * 2);
            delay = s.intervalMs;
        } catch (error) {
            s.error = (error instanceof Error ? error.message : String(error)).slice(0, 500);
            s.intervalMs = Math.min(POLL_MAX_MS, s.intervalMs * 2);
            const retryAt = retryAtOf(error);
            delay = retryAt !== undefined ? Math.max(POLL_FLOOR_MS, retryAt - at) : s.intervalMs;
        }
        for (const t of Object.values(s.pulls)) {
            await record(ctx, t);
            await followTask(ctx, t);
        }
        prune(s);
        s.polledAt = at;
        s.next = at + delay;
        await ctx.save();
        await ctx.reminders.set(PULLS_POLL, { due: delay });
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
            return {
                /** Track the repo the project's origin names (plugins-git `pullRepoOf`) and poll it now. Another repo starts over. */
                async watch(ref: PullsRepo): Promise<PullsView> {
                    requireKey();
                    if (!ref || typeof ref.provider !== 'string' || !PROVIDER_RE.test(ref.provider)) throw new ServerFnError(400, '[pulls] provider must be an adapter id');
                    if (typeof ref.repo !== 'string' || !isRepo(ref.repo)) throw new ServerFnError(400, '[pulls] repo must be owner/name');
                    const s = ctx.state;
                    if (s.repo?.provider !== ref.provider || s.repo.repo !== ref.repo) {
                        s.pulls = {};
                        delete s.error;
                    }
                    s.repo = { provider: ref.provider, repo: ref.repo };
                    s.intervalMs = POLL_FLOOR_MS;
                    await poll(ctx);
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

                /** Poll now. */
                async poll(): Promise<PullsView> {
                    requireKey();
                    await poll(ctx);
                    return view(ctx.state);
                },

                async get(): Promise<PullsView> {
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
