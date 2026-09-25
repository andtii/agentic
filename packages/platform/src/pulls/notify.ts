/**
 * Pull request notifications (#747; PRJ-10; HANDOFF "Pull requests elsewhere" → Notifications): push only when the
 * next move becomes yours, or when autopilot gives up — never for a passing check, never while an agent is on it.
 *
 * `pullMove(pr)` says whose move a PR is (yours, and why) and `pullNotification(prev, next)` turns a change of it
 * into one Inbox row. `notifyPull` sends that row through the Inbox port (`push`, one-way) — a notification is
 * never a gate on the poll.
 */
import type { NotificationRef, PullRequest, WorkspaceId } from '@agentic/core';
import type { ActorContext, AnyActorDefinition } from '@sigx/actors';
import { inboxKey } from '../notify/inbox.js';
import type { NotificationInput } from '../notify/types.js';

/**
 * Why a PR is your move, in priority order:
 * - `gave-up`: autopilot spent its fix attempts on a failing check and stopped.
 * - `conflicts`: it conflicts with the base (autopilot's rebase stops on conflicts too).
 * - `failing`: a check fails and no autopilot fixes checks.
 * - `review`: changes were asked or threads are open and no autopilot answers threads.
 * - `ready`: nothing blocks the merge and autopilot will not merge it on its own.
 */
export type PullMove = 'gave-up' | 'conflicts' | 'failing' | 'review' | 'ready';

type MoveFacts = Pick<PullRequest, 'state' | 'draft' | 'checks' | 'review' | 'mergeable' | 'autopilot'>;

/** Your move on `pr`, or `undefined` while it is someone else's (an agent, CI, a reviewer) or it has settled. */
export function pullMove(pr: MoveFacts): PullMove | undefined {
    if (pr.state !== 'open' || pr.draft) return undefined;
    const auto = pr.autopilot;
    const failing = pr.checks.some((c) => c.state === 'failed');
    const pending = pr.checks.some((c) => c.state === 'queued' || c.state === 'running');
    if (auto?.fixChecks && failing && !pending && auto.activity === undefined && (auto.attempt ?? 0) >= auto.maxAttempts) return 'gave-up';
    if (pr.mergeable === false) return 'conflicts';
    if (failing && !auto?.fixChecks) return 'failing';
    const openThreads = pr.review.threads.some((t) => t.state !== 'resolved');
    if ((pr.review.state === 'changes-requested' || openThreads) && !auto?.answerThreads) return 'review';
    // Waiting on CI, on a reviewer, on the provider's mergeability, or on autopilot's own merge: not yours yet.
    const reviewed = pr.review.state === 'approved' || pr.review.state === 'none';
    if (failing || pending || openThreads || !reviewed || pr.mergeable !== true || auto?.mergeWhenGreen) return undefined;
    return 'ready';
}

const repoName = (pr: Pick<PullRequest, 'repo'>): string => pr.repo.slice(pr.repo.indexOf('/') + 1);

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

const failingNames = (pr: Pick<PullRequest, 'checks'>): string[] => pr.checks.filter((c) => c.state === 'failed').map((c) => c.name);

/** Where the row deep-links: the PR's task, else its chat, else its session. */
function refOf(pr: Pick<PullRequest, 'taskId' | 'chatId' | 'sessionId'>): NotificationRef | undefined {
    if (pr.taskId !== undefined) return { kind: 'task', taskId: pr.taskId };
    if (pr.chatId !== undefined) return { kind: 'chat', chatId: pr.chatId };
    if (pr.sessionId !== undefined) return { kind: 'session', sessionId: pr.sessionId };
    return undefined;
}

function bodyOf(move: PullMove, pr: PullRequest): string {
    const failing = failingNames(pr);
    switch (move) {
        case 'gave-up':
            return `${pr.autopilot!.agentId} tried ${plural(pr.autopilot!.maxAttempts, 'time', 'times')} to fix ${failing.join(', ')} and stopped.`;
        case 'conflicts':
            return `${pr.title} · conflicts with ${pr.base}`;
        case 'failing':
            return `${pr.title} · ${plural(failing.length, 'failing check', 'failing checks')}: ${failing.join(', ')}`;
        case 'review':
            return pr.review.state === 'changes-requested'
                ? `${pr.title} · changes requested`
                : `${pr.title} · ${plural(pr.review.threads.filter((t) => t.state !== 'resolved').length, 'open thread', 'open threads')}`;
        case 'ready': {
            const passed = pr.checks.filter((c) => c.state === 'passed').length;
            const counted = pr.checks.filter((c) => c.state !== 'skipped').length;
            return `${pr.title} · ${passed}/${counted} checks${pr.review.state === 'approved' ? ' · approved' : ''}`;
        }
    }
}

/**
 * The Inbox row for a PR going from `prev` (`undefined` when first read) to `next`, or `undefined`. A row only when
 * the next move becomes yours for a new reason: the same reason again, a passing check, a merge or a close (the
 * task's own row covers those) push nothing.
 */
export function pullNotification(prev: PullRequest | undefined, next: PullRequest): NotificationInput | undefined {
    const move = pullMove(next);
    if (move === undefined || (prev !== undefined && pullMove(prev) === move)) return undefined;
    const name = `${repoName(next)}#${next.number}`;
    const ref = refOf(next);
    return {
        kind: 'input',
        title: move === 'ready' ? `${name} is ready to merge` : `${name} needs you`,
        body: bodyOf(move, next),
        ...(ref ? { ref } : {})
    };
}

/** The slice of the Inbox actor a PR notifies through (`defineInbox`). */
interface InboxClient {
    push(input: NotificationInput): Promise<unknown>;
}

/**
 * Send `pullNotification(prev, next)` to the workspace's Inbox, one-way, when there is a row and an inbox. Never
 * throws: a refusal or an absent inbox does not fail the poll.
 */
export async function notifyPull(
    ctx: Pick<ActorContext<object>, 'actor'>,
    inbox: (() => AnyActorDefinition) | undefined,
    workspaceId: WorkspaceId,
    prev: PullRequest | undefined,
    next: PullRequest
): Promise<NotificationInput | undefined> {
    const row = pullNotification(prev, next);
    const def = inbox?.();
    if (!row || !def) return row;
    try {
        await (ctx.actor(def, inboxKey(workspaceId)).with({ oneWay: true }) as unknown as InboxClient).push(row);
    } catch {
        // A notification is never a gate on the work.
    }
    return row;
}
