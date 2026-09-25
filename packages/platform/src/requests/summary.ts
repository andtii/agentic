/**
 * The project manager keeps you in the loop without extra noise (#763; PRJ-14; docs/design/projects/HANDOFF.md
 * "Project manager and requests"): a weekly summary on Home, and a word in the requester's chat when the item their
 * request became merges.
 *
 * - **Weekly summary.** `pmSummarySchedule()` is the Schedule entry (`{ws}:schedule:sch_pm_{project}`, a `recurring`
 *   cron on the workspace's wall clock, Mon 08:45 by default) a project gets while `pm.policy.weeklySummary` is set.
 *   `pmSummaryTrigger()` wraps the platform's `TriggerPort`: a firing of that entry reads the project's requests over
 *   the hop, builds the week with `weeklySummary()` and posts it through a `PmHomePort` (default: the workspace
 *   Inbox, which Home lists) — every other firing goes on to `next`. A project whose summary was turned off pauses
 *   its entry instead of posting.
 * - **Merge notices.** `notifyRequestersOnMerge()` runs when a plan item merges: every accepted request that became
 *   that item and came from a chat gets `mergeNotice()` posted there through a `RequesterChatPort`, when the
 *   receiving project's policy has `notifyOnMerge`.
 *
 * The text is pure (`weeklySummary`, `mergeNotice`, `requestsForMerge`) and table-tested; the ports carry the I/O.
 */
import { actorKey, PM_POLICY_DEFAULT, type ChatId, type PmPolicy, type PmWeeklySummary, type ProjectId, type ProjectRecord, type ScheduleId, type WorkspaceId } from '@agentic/core';
import { Inbox, inboxKey } from '../notify/index.js';
import type { ScheduleSpec } from '../schedule/actor.js';
import type { ScheduleFired, TriggerHop, TriggerPort, TriggerResult } from '../schedule/ports.js';
import { defineRequestsActor } from './actor.js';
import { requestsKey } from './key.js';
import type { RequestView } from './rules.js';

// ---------------------------------------------------------------------------
// The schedule

/** When a project's summary goes out unless its manager's settings say otherwise: Monday 08:45. */
export const PM_SUMMARY_DEFAULT: PmWeeklySummary = { day: 1, time: '08:45' };

/** The prompt that marks a Schedule entry as a project's weekly summary. */
export const PM_SUMMARY_PROMPT = 'pm:weekly-summary';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** The Schedule id of a project's weekly summary — one per project, so a settings change patches the same entry. */
export function pmSummaryScheduleId(projectId: ProjectId): ScheduleId {
    return `sch_pm_${projectId}` as ScheduleId;
}

/** `{ws}:schedule:sch_pm_{project}`. */
export function pmSummaryScheduleKey(workspaceId: WorkspaceId, projectId: ProjectId): string {
    return actorKey(workspaceId, 'schedule', pmSummaryScheduleId(projectId));
}

/** The cron for a weekly summary (`45 8 * * 1`); throws on a day outside 0–6 or a time that is not `HH:MM`. */
export function pmSummaryCron(summary: PmWeeklySummary = PM_SUMMARY_DEFAULT): string {
    if (!Number.isInteger(summary.day) || summary.day < 0 || summary.day > 6) throw new Error(`[requests] a weekly summary day is 0 (Sunday) to 6, got ${String(summary.day)}`);
    const m = TIME_RE.exec(summary.time);
    if (!m) throw new Error(`[requests] a weekly summary time is HH:MM, got ${String(summary.time)}`);
    return `${Number(m[2])} ${Number(m[1])} * * ${summary.day}`;
}

/**
 * The Schedule entry for a project's weekly summary, on the workspace's time zone `tz`. No agent: the firing is
 * turned into the summary by `pmSummaryTrigger`, not into a task.
 */
export function pmSummarySchedule(project: Pick<ProjectRecord, 'id' | 'name'>, tz: string, summary: PmWeeklySummary = PM_SUMMARY_DEFAULT): ScheduleSpec {
    return {
        kind: 'recurring',
        title: `Weekly summary · ${project.name}`,
        recurrence: { kind: 'cron', cron: pmSummaryCron(summary), tz },
        projectId: project.id,
        prompt: PM_SUMMARY_PROMPT
    };
}

/** Whether a firing is a project's weekly summary. */
export const isPmSummary = (event: Pick<ScheduleFired, 'prompt' | 'projectId' | 'scheduleId'>): boolean =>
    event.prompt === PM_SUMMARY_PROMPT && event.projectId !== undefined && event.scheduleId === pmSummaryScheduleId(event.projectId);

// ---------------------------------------------------------------------------
// The week

/** What one summary covers: the project's requests either way, in `[since, now)`. */
export interface PmWeek {
    readonly projectName: string;
    readonly since: number;
    readonly now: number;
    /** Requests sent to the project (`Requests.incoming()`). */
    readonly incoming: readonly RequestView[];
    /** Requests the project sent (`Requests.sent()`). */
    readonly sent?: readonly RequestView[];
}

export interface PmSummaryCounts {
    /** Arrived this week. */
    readonly received: number;
    /** Accepted this week (each became a plan item). */
    readonly accepted: number;
    /** Declined this week. */
    readonly declined: number;
    /** Waiting on a person now, whenever they arrived. */
    readonly needsYou: number;
    /** Waiting on the sender now. */
    readonly askedForMore: number;
    /** Sent to other projects this week. */
    readonly sent: number;
    /** Sent requests another project accepted this week. */
    readonly sentAccepted: number;
}

export interface PmSummary {
    readonly title: string;
    readonly body: string;
    readonly counts: PmSummaryCounts;
    /** Nothing happened and nothing waits: a quiet week. The summary is still posted, as one line. */
    readonly quiet: boolean;
}

const LIST_MAX = 5;
const inWeek = (at: number, week: PmWeek): boolean => at >= week.since && at < week.now;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function lines(title: string, rs: readonly RequestView[], line: (r: RequestView) => string): string[] {
    if (!rs.length) return [];
    const shown = rs.slice(0, LIST_MAX).map((r) => `- ${line(r)}`);
    if (rs.length > LIST_MAX) shown.push(`- and ${rs.length - LIST_MAX} more`);
    return ['', title, ...shown];
}

/** The week's summary: what arrived and was decided, what waits on you, and how the project's own requests fared. */
export function weeklySummary(week: PmWeek): PmSummary {
    const sent = week.sent ?? [];
    const received = week.incoming.filter((r) => inWeek(r.createdAt, week));
    const accepted = week.incoming.filter((r) => r.state === 'accepted' && inWeek(r.updatedAt, week));
    const declined = week.incoming.filter((r) => r.state === 'declined' && inWeek(r.updatedAt, week));
    const needsYou = week.incoming.filter((r) => r.state === 'needs-you');
    const askedForMore = week.incoming.filter((r) => r.state === 'asked-for-more');
    const sentThisWeek = sent.filter((r) => inWeek(r.createdAt, week));
    const sentAccepted = sent.filter((r) => r.state === 'accepted' && inWeek(r.updatedAt, week));
    const counts: PmSummaryCounts = {
        received: received.length,
        accepted: accepted.length,
        declined: declined.length,
        needsYou: needsYou.length,
        askedForMore: askedForMore.length,
        sent: sentThisWeek.length,
        sentAccepted: sentAccepted.length
    };
    const quiet = Object.values(counts).every((n) => n === 0);
    const title = `Weekly summary · ${week.projectName}`;
    if (quiet) return { title, body: 'A quiet week: no requests came in or went out, and nothing waits on you.', counts, quiet };
    const head = [
        `${plural(counts.received, 'request')} came in: ${counts.accepted} accepted, ${counts.declined} declined.`,
        counts.needsYou ? `${plural(counts.needsYou, 'request')} ${counts.needsYou === 1 ? 'waits' : 'wait'} on you.` : 'Nothing waits on you.',
        ...(counts.askedForMore ? [`${plural(counts.askedForMore, 'request')} ${counts.askedForMore === 1 ? 'waits' : 'wait'} on the sender.`] : []),
        ...(counts.sent || counts.sentAccepted ? [`${week.projectName} sent ${plural(counts.sent, 'request')}; ${counts.sentAccepted} accepted elsewhere.`] : [])
    ];
    const body = [
        head.join(' '),
        ...lines('Needs you:', needsYou, (r) => `${r.id} from ${r.fromProject}: ${r.title}`),
        ...lines('Accepted:', accepted, (r) => `${r.id}: ${r.title}${r.resultItem !== undefined ? ` → #${r.resultItem}` : ''}`),
        ...lines('Declined:', declined, (r) => `${r.id}: ${r.title}${r.declineReason ? ` (${r.declineReason})` : ''}`)
    ].join('\n');
    return { title, body, counts, quiet };
}

// ---------------------------------------------------------------------------
// Posting the summary

/** One summary, as it goes to Home. */
export interface PmSummaryPost extends PmSummary {
    readonly workspaceId: WorkspaceId;
    readonly projectId: ProjectId;
    /** The firing's due instant — the week ends here. */
    readonly scheduledFor: number;
    readonly scheduleId: ScheduleId;
}

/** Where a summary goes. A rejection is retried by the Schedule actor, so a post is idempotent per `scheduledFor`. */
export interface PmHomePort {
    post(hop: TriggerHop, summary: PmSummaryPost): Promise<void>;
}

/** The slice of the Inbox a summary posts through (`defineInbox`). */
interface SummaryInbox {
    list(): Promise<readonly { readonly title: string; readonly body?: string; readonly ref?: { readonly kind: string; readonly scheduleId?: string } }[]>;
    push(input: { kind: 'reminder'; title: string; body: string; ref: { kind: 'schedule'; scheduleId: ScheduleId } }): Promise<unknown>;
}

/** The production Home: one Inbox row (`reminder`, deep-linked to the schedule), which Home lists; a retried firing finds its row and posts nothing. */
export const inboxSummaryHome: PmHomePort = {
    async post(hop, s) {
        const inbox = hop.actor(Inbox, inboxKey(s.workspaceId)) as unknown as SummaryInbox;
        const title = `${s.title} · ${new Date(s.scheduledFor).toISOString().slice(0, 10)}`;
        if ((await inbox.list()).some((n) => n.title === title && n.ref?.kind === 'schedule' && n.ref.scheduleId === s.scheduleId)) return;
        await inbox.push({ kind: 'reminder', title, body: s.body, ref: { kind: 'schedule', scheduleId: s.scheduleId } });
    }
};

/** Where the trigger reads the project's name and manager policy. */
export interface PmSummaryProjectPort {
    project(hop: TriggerHop, workspaceId: WorkspaceId, projectId: ProjectId): Promise<Pick<ProjectRecord, 'id' | 'name' | 'pm'> | undefined>;
}

/** The week's requests for a project. Default: its Requests actor over the hop. */
export interface PmSummaryRequestsPort {
    requests(hop: TriggerHop, workspaceId: WorkspaceId, projectId: ProjectId): Promise<{ incoming: readonly RequestView[]; sent: readonly RequestView[] }>;
}

/** Only its `type` matters for a hop: the host runs the app's own Requests definition. */
let requestsRef: ReturnType<typeof defineRequestsActor> | undefined;

/** The production requests: `incoming()` and `sent()` on the project's Requests actor. */
export const actorSummaryRequests: PmSummaryRequestsPort = {
    async requests(hop, workspaceId, projectId) {
        requestsRef ??= defineRequestsActor();
        const client = hop.actor(requestsRef, requestsKey(workspaceId, projectId));
        const [incoming, sent] = await Promise.all([client.incoming(), client.sent()]);
        return { incoming, sent };
    }
};

export interface PmSummaryTriggerOptions {
    readonly projects: PmSummaryProjectPort;
    /** Default: `inboxSummaryHome`. */
    readonly home?: PmHomePort;
    /** Default: `actorSummaryRequests`. */
    readonly requests?: PmSummaryRequestsPort;
    /** Every firing that is not a weekly summary (production: `scheduleTrigger()`). Absent → ignored. */
    readonly next?: TriggerPort;
}

/** What one weekly-summary firing did. */
export type PmSummaryOutcome = { readonly posted: PmSummaryPost } | { readonly paused: string };

/**
 * Deliver one weekly-summary firing: read the project and its requests, post the week to Home. A project that is
 * gone, or whose summary was turned off, pauses the entry rather than posting.
 */
export async function deliverPmSummary(event: ScheduleFired, hop: TriggerHop, options: PmSummaryTriggerOptions): Promise<PmSummaryOutcome> {
    const projectId = event.projectId!;
    const project = await options.projects.project(hop, event.workspaceId, projectId);
    if (!project) return { paused: `project ${projectId} is gone` };
    if (!project.pm?.policy.weeklySummary) return { paused: 'the weekly summary is off in the project manager settings' };
    const { incoming, sent } = await (options.requests ?? actorSummaryRequests).requests(hop, event.workspaceId, projectId);
    const summary = weeklySummary({ projectName: project.name, since: event.scheduledFor - WEEK_MS, now: event.scheduledFor, incoming, sent });
    const posted: PmSummaryPost = { ...summary, workspaceId: event.workspaceId, projectId, scheduledFor: event.scheduledFor, scheduleId: event.scheduleId };
    await (options.home ?? inboxSummaryHome).post(hop, posted);
    return { posted };
}

/** The platform's trigger with weekly summaries in front: a summary firing posts the week, every other firing goes to `next`. */
export function pmSummaryTrigger(options: PmSummaryTriggerOptions): TriggerPort {
    return {
        async fired(event, hop): Promise<void | TriggerResult> {
            if (!isPmSummary(event)) return options.next?.fired(event, hop);
            const outcome = await deliverPmSummary(event, hop, options);
            return 'paused' in outcome ? { pause: outcome.paused } : undefined;
        }
    };
}

// ---------------------------------------------------------------------------
// Telling requesters on merge

/** A plan item that merged, in the project whose requests it may answer. */
export interface MergedItem {
    readonly workspaceId: WorkspaceId;
    readonly projectId: ProjectId;
    /** The item number (`#n`) in `projectId`. */
    readonly item: number;
    /** The merge, when a pull request made it (`agentic#812`). */
    readonly pull?: string;
}

/** The requests to tell about `item` merging: accepted into it, and sent from a chat. */
export function requestsForMerge(incoming: readonly RequestView[], item: number): RequestView[] {
    return incoming.filter((r) => r.state === 'accepted' && r.resultItem === item && r.fromChat !== undefined);
}

/** What the requester's chat reads: `signalx#3 merged (agentic#812): "batch() drops nested effects" (req_1) is done.` */
export function mergeNotice(projectName: string, request: Pick<RequestView, 'id' | 'title'>, merged: Pick<MergedItem, 'item' | 'pull'>): string {
    return `${projectName}#${merged.item} merged${merged.pull ? ` (${merged.pull})` : ''}: your request "${request.title}" (${request.id}) is done.`;
}

/** How a notice reaches the requester's chat. */
export interface RequesterChatPort {
    post(hop: TriggerHop, workspaceId: WorkspaceId, chatId: ChatId, text: string, request: RequestView): Promise<void>;
}

export interface MergeNoticeOptions {
    readonly chat: RequesterChatPort;
    /** The receiving project: its name, and its manager's policy (`notifyOnMerge`). */
    readonly project: Pick<ProjectRecord, 'id' | 'name' | 'pm'>;
    /** Default: `actorSummaryRequests` (only `incoming` is read). */
    readonly requests?: PmSummaryRequestsPort;
}

/**
 * Tell each requester whose request became `merged.item` that it merged, in the chat the request came from — when
 * the receiving project's policy says `notifyOnMerge` (the default). One failing chat does not stop the others.
 * Returns the notices sent.
 */
export async function notifyRequestersOnMerge(hop: TriggerHop, merged: MergedItem, options: MergeNoticeOptions): Promise<{ readonly chatId: ChatId; readonly requestId: string; readonly text: string }[]> {
    const policy: PmPolicy = options.project.pm?.policy ?? PM_POLICY_DEFAULT;
    if (!policy.notifyOnMerge) return [];
    const { incoming } = await (options.requests ?? actorSummaryRequests).requests(hop, merged.workspaceId, merged.projectId);
    const sent: { chatId: ChatId; requestId: string; text: string }[] = [];
    for (const r of requestsForMerge(incoming, merged.item)) {
        const text = mergeNotice(options.project.name, r, merged);
        try {
            await options.chat.post(hop, merged.workspaceId, r.fromChat!, text, r);
            sent.push({ chatId: r.fromChat!, requestId: r.id, text });
        } catch {
            // A notice is never a gate on the merge.
        }
    }
    return sent;
}
