/**
 * `QuotaMeter` and `QuotaPanel` on the `ag-quota` / `ag-quota-panel` scopes
 * (#270, part of #261): provider limits laid out like Claude Code's `/usage`
 * — a bold label, a bar coloured by status, "76% used", "Resets Sep 22 at
 * 8pm (Europe/Stockholm)". A panel is one account's snapshot: its windows,
 * how old it is (stale past `QUOTA_STALE_MS`), or — when the provider
 * reports nothing — "Not reported by provider — <reason>" (OPS-07, PLG-09).
 */
import { component, type Define } from '@sigx/runtime-core';
import { tightestWindow, type QuotaSnapshot, type QuotaWindow } from '@agentic/core';
import { agQuotaAnatomy, agQuotaPanelAnatomy } from './anatomy.js';
import { ageText, isQuotaStale, quotaPercent, quotaShortLabel, quotaTone, quotaUsedText, resetsText } from './quota.js';
import { Tag } from './StatusPill.js';

const SCOPE = agQuotaAnatomy.scope;
const PANEL = agQuotaPanelAnatomy.scope;

export type QuotaMeterProps =
    & Define.Prop<'window', QuotaWindow, true>
    /** The snapshot it belongs to is old: the bar dims. */
    & Define.Prop<'stale', boolean>
    /** For "today" in the reset line; `Date.now()` by default. */
    & Define.Prop<'now', number>
    /** The viewer's time zone by default. */
    & Define.Prop<'timeZone', string>
    /** One line — label, a short bar, the percent — with the reset time as the tooltip (#315: chat members, the folder picker, New chat). */
    & Define.Prop<'compact', boolean>
    & Define.Prop<'class', string>;

export const QuotaMeter = component<QuotaMeterProps>(({ props }) => () => {
    const w = props.window;
    const percent = quotaPercent(w);
    const resets = resetsText(w.resetsAt, { ...(props.now !== undefined ? { now: props.now } : {}), ...(props.timeZone ? { timeZone: props.timeZone } : {}) });
    return (
        <div data-scope={SCOPE} data-part="root" data-tone={quotaTone(w.status)} data-status={w.status} data-mod-stale={props.stale ? '' : undefined} data-mod-compact={props.compact ? '' : undefined} data-window={w.id} title={props.compact ? [w.label, resets].filter(Boolean).join(' · ') : undefined} class={props.class}>
            <span data-scope={SCOPE} data-part="label">{props.compact ? quotaShortLabel(w) : w.label}</span>
            <span
                data-scope={SCOPE}
                data-part="bar"
                role="progressbar"
                aria-label={w.label}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent ?? undefined}
                aria-valuetext={quotaUsedText(w)}
            >
                <span data-scope={SCOPE} data-part="fill" style={`inline-size: ${percent ?? 0}%`} />
            </span>
            <span data-scope={SCOPE} data-part="used">{quotaUsedText(w)}</span>
            {resets && !props.compact ? <span data-scope={SCOPE} data-part="resets">{resets}</span> : null}
        </div>
    );
}, { name: 'QuotaMeter' });

export type QuotaBadgeProps =
    /** The account's snapshot; `null` = nothing reported yet, `undefined` = not an account with limits (say `note`). */
    & Define.Prop<'snapshot', QuotaSnapshot | null | undefined>
    /** What to say when there is no window to show — e.g. "No plan limits" for a model runtime. */
    & Define.Prop<'note', string>
    & Define.Prop<'now', number>
    & Define.Prop<'staleMs', number>
    & Define.Prop<'class', string>;

/**
 * One account's limits in one line (#315): the window closest to its limit as a compact meter, or a muted note —
 * "Not reported — <reason>", "No usage reported yet", or the caller's `note`. For wherever an account is chosen.
 */
export const QuotaBadge = component<QuotaBadgeProps>(({ props }) => () => {
    const s = props.snapshot;
    const w = s ? (tightestWindow(s) ?? s.windows[0]) : undefined;
    if (s && w) return <QuotaMeter window={w} compact stale={isQuotaStale(s, props.now ?? Date.now(), props.staleMs)} class={props.class} />;
    const note = s?.availability === 'not-reported' ? `Not reported${s.reason ? ` — ${s.reason}` : ''}` : s === null ? 'No usage reported yet' : props.note;
    if (!note) return null;
    return (
        <span data-scope={SCOPE} data-part="root" data-tone="muted" data-mod-compact="" data-quota-note="" class={props.class}>
            <span data-scope={SCOPE} data-part="label">{note}</span>
        </span>
    );
}, { name: 'QuotaBadge' });

export type QuotaPanelProps =
    /** `null`: nothing reported yet. */
    & Define.Prop<'snapshot', QuotaSnapshot | null, true>
    /** The account, when the panel stands alone (`Work · you@example.com`). */
    & Define.Prop<'title', string>
    /** Only the window closest to its limit — the Home rail's one line per account. */
    & Define.Prop<'compact', boolean>
    & Define.Prop<'now', number>
    & Define.Prop<'timeZone', string>
    /** Older than this is stale; `QUOTA_STALE_MS` by default. */
    & Define.Prop<'staleMs', number>
    & Define.Prop<'class', string>;

export const QuotaPanel = component<QuotaPanelProps>(({ props }) => () => {
    const s = props.snapshot;
    const now = props.now ?? Date.now();
    const stale = !!s && isQuotaStale(s, now, props.staleMs);
    const windows = !s ? [] : props.compact ? [tightestWindow(s) ?? s.windows[0]].filter((w): w is QuotaWindow => !!w) : s.windows;
    const reason = !s ? 'No usage reported yet' : s.availability === 'not-reported' ? `Not reported by provider — ${s.reason ?? 'no reason given'}` : windows.length === 0 ? 'No limits reported' : undefined;
    return (
        <section data-scope={PANEL} data-part="root" data-mod-stale={stale ? '' : undefined} data-mod-compact={props.compact ? '' : undefined} data-availability={s?.availability ?? 'none'} aria-label={props.title ? `Usage limits: ${props.title}` : 'Usage limits'} class={props.class}>
            {props.title || s ? (
                <div data-scope={PANEL} data-part="header">
                    {props.title ? <span data-scope={PANEL} data-part="title">{props.title}</span> : null}
                    {s?.plan ? <Tag>{s.plan}</Tag> : null}
                    {s ? (
                        <span data-scope={PANEL} data-part="age" title={new Date(s.observedAt).toISOString()}>
                            {stale ? `Stale · ${ageText(now - s.observedAt)}` : `Updated ${ageText(now - s.observedAt)}`}
                        </span>
                    ) : null}
                </div>
            ) : null}
            {reason ? <p data-scope={PANEL} data-part="reason">{reason}</p> : null}
            {windows.map((w) => <QuotaMeter window={w} stale={stale} now={now} {...(props.timeZone ? { timeZone: props.timeZone } : {})} />)}
        </section>
    );
}, { name: 'QuotaPanel' });
