/**
 * `QuotaRings` on the `ag-quota-rings` scope (#452, part of #450): a chat
 * member's limits at a glance — one small ring per window that limits the
 * model it runs (`memberWindows`: the account's shared session and week,
 * plus the model's own week), each with its percent and a one-word label:
 * `12% SESSION`, `77% WEEK`, `100% FABLE`. Another model's week is not
 * drawn; the account's full panel is `QuotaPanel`. Month and other periods
 * stay in the panel.
 */
import { component, type Define } from '@sigx/runtime-core';
import { memberWindows, type QuotaSnapshot, type QuotaWindow } from '@agentic/core';
import { agQuotaRingsAnatomy } from './anatomy.js';
import { isQuotaStale, quotaPercent, quotaTone, quotaUsedText } from './quota.js';

const SCOPE = agQuotaRingsAnatomy.scope;
const R = 12;

/** The windows a member's rings draw: `memberWindows` for its model, sessions and weeks only. */
export function ringWindows(s: Pick<QuotaSnapshot, 'windows'>, model?: string): readonly QuotaWindow[] {
    return memberWindows(s, model).filter((w) => w.period === 'session' || w.period === 'week');
}

/** `Session`, `Week`, or the model a week is scoped to (`Fable`). */
export function ringLabel(w: Pick<QuotaWindow, 'label' | 'period' | 'scope'>): string {
    if (w.scope?.model) return w.scope.model;
    return w.period === 'session' ? 'Session' : w.period === 'week' ? 'Week' : w.label;
}

export type QuotaRingsProps =
    & Define.Prop<'snapshot', QuotaSnapshot, true>
    /** The model the member runs; without one, only the account's shared windows. */
    & Define.Prop<'model', string>
    & Define.Prop<'now', number>
    & Define.Prop<'staleMs', number>
    & Define.Prop<'class', string>;

export const QuotaRings = component<QuotaRingsProps>(({ props }) => () => {
    const s = props.snapshot;
    const windows = ringWindows(s, props.model);
    if (!windows.length) return null;
    return (
        <div data-scope={SCOPE} data-part="root" data-mod-stale={isQuotaStale(s, props.now ?? Date.now(), props.staleMs) ? '' : undefined} class={props.class}>
            {windows.map((w) => {
                // A limit the provider reports without a number (Claude Code's limit message) is still full.
                const percent = quotaPercent(w) ?? (w.status === 'exhausted' ? 100 : null);
                const label = ringLabel(w);
                return (
                    <span
                        data-scope={SCOPE}
                        data-part="item"
                        data-tone={quotaTone(w.status)}
                        data-status={w.status}
                        data-window={w.id}
                        role="progressbar"
                        aria-label={label}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={percent ?? undefined}
                        aria-valuetext={quotaUsedText(w)}
                        title={w.label}
                    >
                        <svg data-scope={SCOPE} data-part="ring" viewBox="0 0 28 28" aria-hidden="true">
                            <circle data-track="" cx="14" cy="14" r={R} />
                            {percent ? <circle data-arc="" cx="14" cy="14" r={R} pathLength="100" stroke-dasharray={`${percent} 100`} /> : null}
                        </svg>
                        <span data-scope={SCOPE} data-part="value">{percent === null ? '—' : `${percent}%`}</span>
                        <span data-scope={SCOPE} data-part="label">{label}</span>
                    </span>
                );
            })}
        </div>
    );
}, { name: 'QuotaRings' });
