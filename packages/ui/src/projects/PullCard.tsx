/**
 * `PullCard` — one pull request, the same card and the same state everywhere it appears (PRJ-10;
 * docs/design/projects/HANDOFF.md, "Pull request", board `PullSurfaces`). Each surface draws the one `PullRequest`
 * and drops what it has no room for:
 *
 * - `chat` — the live card an agent's message carries instead of a link: title, `autopilot` badge, number, the
 *   checks bar, the review state, what autopilot is doing (`fixing size-limit · attempt 2 of 3`), Open / View diff.
 *   It re-renders from the record, so it updates in place.
 * - `home` — a Needs-you item: the next move as an amber pill (`MERGE`), `agentic#602 is ready`, the title with
 *   checks and review in one line, `Squash and merge` (emits `merge`) and Open.
 * - `task` — one mono line on a task node: `#602 · ready to merge`. It never links (the node is the button).
 * - `notification` — `agentic#603 needs you` and why.
 *
 * `pullNextMove` decides whether the next move is yours; Home lists only those PRs (`pullNeedsYou`).
 */
import { component, type Define } from '@sigx/runtime-core';
import { pullBlockers, type PullRequest } from '@agentic/core';
import { AgentTile, type AgentHue } from '../kit/AgentTile.js';
import { Button } from '../kit/Button.js';
import { ChecksBar, countChecks } from './ChecksBar.js';

/** Where the card sits; each surface drops what it has no room for. */
export type PullCardSurface = 'chat' | 'home' | 'task' | 'notification';

/** A move that is yours: merge a ready PR, review one asked of you, decide conflicts, or take over where autopilot stopped. */
export type PullMove = 'merge' | 'review' | 'conflicts' | 'stopped';

export type PullCardProps =
    & Define.Prop<'pull', PullRequest, true>
    /** The PR page (`/projects/:id/work/pr:<n>`); without it the card does not link. */
    & Define.Prop<'href', string>
    & Define.Prop<'surface', PullCardSurface>
    /** The PR's changes (`chat`: "View diff"). */
    & Define.Prop<'diffHref', string>
    /** Who is looking (a login or an agent id): a review requested from them is their move. */
    & Define.Prop<'me', string>
    /** The autopilot agent as the page names it (`Forge`); the agent id otherwise. */
    & Define.Prop<'agentName', string>
    & Define.Prop<'agentHue', AgentHue>
    /** `home`: the merge is under way. */
    & Define.Prop<'merging', boolean>
    & Define.Prop<'class', string>
    /** `home`: "Squash and merge" pressed. */
    & Define.Event<'merge', PullRequest>;

/** A value shaped like a `PullRequest` — how a tool result carries one into the chat. */
export function isPullRequest(value: unknown): value is PullRequest {
    if (!value || typeof value !== 'object') return false;
    const v = value as Partial<PullRequest>;
    return typeof v.provider === 'string' && typeof v.repo === 'string' && typeof v.number === 'number' && typeof v.title === 'string'
        && (v.state === 'open' || v.state === 'merged' || v.state === 'closed') && Array.isArray(v.checks)
        && !!v.review && typeof v.review === 'object' && Array.isArray(v.review.threads) && Array.isArray(v.review.reviewers);
}

/** Autopilot used every fix attempt and stopped with checks still failing. */
function autopilotStopped(pr: PullRequest): boolean {
    const a = pr.autopilot;
    if (!a || !a.fixChecks) return false;
    return (a.attempt ?? 0) >= a.maxAttempts && !a.activity && pr.checks.some((c) => c.state === 'failed');
}

/**
 * Whose move it is, when it is yours — `undefined` when an agent (or nobody) can take it: a merged, closed or draft
 * PR, checks still running, threads the agent is answering, a merge autopilot will make itself.
 */
export function pullNextMove(pr: PullRequest, me?: string): PullMove | undefined {
    if (pr.state !== 'open' || pr.draft) return undefined;
    if (pr.mergeable === false) return 'conflicts';
    if (autopilotStopped(pr)) return 'stopped';
    if (me !== undefined && pr.review.state === 'requested' && pr.review.reviewers.includes(me)) return 'review';
    if (pr.mergeable === true && pullBlockers(pr).length === 0 && !pr.autopilot?.mergeWhenGreen) return 'merge';
    return undefined;
}

/** Home's Needs-you list takes a PR only when the next move is yours. */
export function pullNeedsYou(pr: PullRequest, me?: string): boolean {
    return pullNextMove(pr, me) !== undefined;
}

/** The PR's state in a few words, the same on every surface: `ready to merge`, `1 failing check`, `merged`. */
export function pullStatusText(pr: PullRequest, me?: string): string {
    if (pr.state === 'merged') return 'merged';
    if (pr.state === 'closed') return 'closed';
    if (pr.draft) return 'draft';
    const move = pullNextMove(pr, me);
    if (move === 'merge') return 'ready to merge';
    if (move === 'review') return 'review requested';
    if (move === 'stopped') return 'autopilot stopped';
    return pullBlockers(pr)[0] ?? (pr.mergeable === undefined ? 'checking mergeability' : 'open');
}

/** `andtii/agentic` → `agentic#602`. */
export function pullName(pr: Pick<PullRequest, 'repo' | 'number'>): string {
    return `${pr.repo.slice(pr.repo.lastIndexOf('/') + 1)}#${pr.number}`;
}

const MOVE_PILL: Readonly<Record<PullMove, string>> = { merge: 'MERGE', review: 'REVIEW', conflicts: 'CONFLICTS', stopped: 'STOPPED' };
const MOVE_HEADLINE: Readonly<Record<PullMove, string>> = { merge: 'is ready', review: 'needs your review', conflicts: 'has conflicts to decide', stopped: 'needs you' };

/** The review in words and tone: `Changes asked` (amber), `Lint approved` (live), `Review requested` (dim). */
function reviewText(pr: PullRequest): { text: string; tone: string } | undefined {
    const who = pr.review.reviewers.join(', ');
    switch (pr.review.state) {
        case 'approved': return { text: who ? `${who} approved` : 'Approved', tone: 'var(--color-primary)' };
        case 'changes-requested': return { text: 'Changes asked', tone: 'var(--color-warning)' };
        case 'requested': return { text: 'Review requested', tone: 'var(--ag-text-muted)' };
        default: return undefined;
    }
}

/** `9/9 checks`, `1 failing`, `no checks` — Home's one-line summary. */
function checksText(pr: PullRequest): string {
    const n = countChecks(pr.checks);
    const counted = pr.checks.length - n.skipped;
    if (!counted) return 'no checks';
    if (n.failed) return `${n.failed} failing`;
    if (n.running + n.queued) return `${n.running + n.queued} running`;
    return `${n.passed}/${counted} checks`;
}

/** The pull request glyph (docs/design/projects/boards/PullSurfaces.dc.html). */
const PullGlyph = component<Define.Prop<'size', number> & Define.Prop<'color', string>>(({ props }) => () => (
    <svg width={props.size ?? 16} height={props.size ?? 16} viewBox="0 0 24 24" fill="none" stroke={props.color ?? 'currentColor'} stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink: 0">
        <circle cx="6" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="18" r="2" />
        <path d="M6 8v8" /><path d="M18 16V9a3 3 0 0 0-3-3h-4" /><path d="m13 4-2 2 2 2" />
    </svg>
), { name: 'PullCard.Glyph' });

const pillStyle = 'display: inline-flex; align-items: center; gap: 6px; block-size: 22px; padding: 0 8px; border: 1px solid color-mix(in oklab, var(--color-warning) 33%, transparent); border-radius: 4px; background-color: color-mix(in oklab, var(--color-warning) 8%, transparent); flex-shrink: 0; font-family: var(--font-mono); font-size: 11px; font-weight: 500; letter-spacing: 0.04em; color: var(--color-warning); white-space: nowrap';
const dotStyle = 'inline-size: 6px; block-size: 6px; border-radius: 50%; background-color: var(--color-warning); flex-shrink: 0';
const boxStyle = 'display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; background-color: var(--color-base-200); border: 1px solid var(--ag-line); border-radius: 8px; min-inline-size: 0';
const rowStyle = 'display: flex; align-items: center; gap: 8px; min-inline-size: 0';
const titleStyle = 'font-size: 13px; font-weight: 600; color: var(--color-base-content); flex-grow: 1; min-inline-size: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis';
const monoDim = 'font-family: var(--font-mono); font-size: 12px; color: var(--ag-text-dim); white-space: nowrap';
const smallMuted = 'font-size: 12px; color: var(--ag-text-muted); min-inline-size: 0';
const badgeStyle = 'display: inline-flex; align-items: center; block-size: 20px; padding: 0 6px; border-radius: 4px; border: 1px solid color-mix(in oklab, var(--color-info) 33%, transparent); color: var(--color-info); font-family: var(--font-mono); font-size: 10px; font-weight: 600; flex-shrink: 0';

export const PullCard = component<PullCardProps>(({ props, emit }) => () => {
    const pr = props.pull;
    const surface = props.surface ?? 'chat';
    const move = pullNextMove(pr, props.me);
    const status = pullStatusText(pr, props.me);
    const root = (style: string, children: unknown) => (
        <div data-ag-project="pull-card" data-surface={surface} data-pull={String(pr.number)} data-state={pr.state} data-move={move} class={props.class} style={style}>
            {children}
        </div>
    );

    if (surface === 'task') {
        return root('display: inline-flex; align-items: center; gap: 6px; min-inline-size: 0', [
            <PullGlyph size={13} color={move ? 'var(--color-warning)' : 'var(--color-primary)'} />,
            <span data-pull-status="" style="font-family: var(--font-mono); font-size: 12px; color: var(--ag-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis">{`#${pr.number} · ${status}`}</span>
        ]);
    }

    if (surface === 'notification') {
        const why = move === 'stopped' && pr.autopilot
            ? `${props.agentName ?? pr.autopilot.agentId} tried ${pr.autopilot.maxAttempts} times to fix the checks and stopped.`
            : `${pr.title} · ${status}`;
        const head = `${pullName(pr)} ${move ? 'needs you' : status}`;
        return root('display: flex; flex-direction: column; gap: 4px; min-inline-size: 0', [
            <span data-pull-headline="" style="font-size: 13px; font-weight: 600; color: var(--color-base-content)">{props.href ? <a href={props.href}>{head}</a> : head}</span>,
            <span data-pull-status="" style={smallMuted}>{why}</span>
        ]);
    }

    const review = reviewText(pr);

    if (surface === 'home') {
        const headline = `${pullName(pr)} ${move ? MOVE_HEADLINE[move] : status}`;
        const detail = [pr.title, checksText(pr), review?.text].filter(Boolean).join(' · ');
        return root(boxStyle, [
            <div style={rowStyle}>
                {move ? <span data-pull-pill="" style={pillStyle}><span style={dotStyle} aria-hidden="true" />{MOVE_PILL[move]}</span> : null}
                <span data-pull-headline="" style={titleStyle}>{headline}</span>
            </div>,
            <span data-pull-detail="" style={smallMuted}>{detail}</span>,
            <div style={rowStyle}>
                {move === 'merge' ? <Button intent="wait" loading={props.merging} onClick={() => emit('merge', pr)}>Squash and merge</Button> : null}
                {props.href ? <Button intent="default" href={props.href}>Open</Button> : null}
            </div>
        ]);
    }

    // chat
    const a = pr.autopilot;
    return root(boxStyle, [
        <div style={rowStyle}>
            <PullGlyph color="var(--ag-text-muted)" />
            <span data-pull-title="" style={titleStyle} title={pr.title}>{pr.title}</span>
            {a && pr.state === 'open' ? <span data-pull-autopilot="" style={badgeStyle}>autopilot</span> : null}
            <span style={monoDim}>{`#${pr.number}`}</span>
        </div>,
        pr.state === 'open'
            ? (
                <div style="display: flex; align-items: center; gap: 16px; flex-wrap: wrap">
                    <ChecksBar checks={pr.checks} />
                    {review ? <span data-pull-review="" style={`font-size: 12px; font-weight: 500; white-space: nowrap; color: ${review.tone}`}>{review.text}</span> : null}
                    {move ? <span data-pull-move="" style="font-size: 12px; font-weight: 500; white-space: nowrap; color: var(--color-warning)">{status}</span> : null}
                </div>
            )
            : <span data-pull-status="" style={smallMuted}>{status}</span>,
        a && a.activity && pr.state === 'open'
            ? (
                <div data-pull-activity="" style={rowStyle}>
                    <AgentTile name={props.agentName ?? a.agentId} hue={props.agentHue} size={18} />
                    <span style="font-size: 12px; font-weight: 600; color: var(--color-base-content)">{props.agentName ?? a.agentId}</span>
                    <span style={smallMuted}>{`${a.activity}${a.attempt ? ` · attempt ${a.attempt} of ${a.maxAttempts}` : ''}`}</span>
                </div>
            )
            : null,
        props.href || props.diffHref
            ? (
                <div style="display: flex; align-items: center; gap: 14px; font-size: 12px">
                    {props.href ? <a href={props.href} style="font-weight: 600">Open</a> : null}
                    {props.diffHref ? <a href={props.diffHref}>View diff</a> : null}
                </div>
            )
            : null
    ]);
}, { name: 'PullCard' });
