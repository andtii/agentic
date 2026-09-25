/**
 * `ChecksBar` — a pull request's checks as one 96 × 6 px bar on `line-strong`, passed (`live`), running or queued
 * (`working`) and failed (`failed`) in proportion, with a mono 11 px summary under it
 * (docs/design/projects/HANDOFF.md, "Work"): `9/9 passed`, `1 failing · 1 running`, `no checks`. The summary says the
 * state in words, so colour is never the only signal; the bar itself is decorative.
 */
import { component, type Define } from '@sigx/runtime-core';
import type { PullCheck, PullCheckState } from '@agentic/core';

export type ChecksBarProps =
    & Define.Prop<'checks', readonly PullCheck[], true>
    & Define.Prop<'class', string>;

type Tone = 'failed' | 'running' | 'queued' | 'passed' | 'none';

export interface ChecksSummaryPart {
    readonly tone: Tone;
    readonly text: string;
}

/** Count the checks by state. */
export function countChecks(checks: readonly PullCheck[]): Record<PullCheckState, number> {
    const counts: Record<PullCheckState, number> = { queued: 0, running: 0, passed: 0, failed: 0, skipped: 0 };
    for (const check of checks) counts[check.state]++;
    return counts;
}

/** The summary under the bar, as toned parts joined by ` · `. */
export function checksSummary(checks: readonly PullCheck[]): ChecksSummaryPart[] {
    const n = countChecks(checks);
    const counted = checks.length - n.skipped;
    if (counted === 0) return [{ tone: 'none', text: checks.length ? `${n.skipped} skipped` : 'no checks' }];
    const parts: ChecksSummaryPart[] = [];
    if (n.failed) parts.push({ tone: 'failed', text: `${n.failed} failing` });
    if (n.running) parts.push({ tone: 'running', text: `${n.running} running` });
    if (n.queued) parts.push({ tone: 'queued', text: `${n.queued} queued` });
    return parts.length ? parts : [{ tone: 'passed', text: `${n.passed}/${counted} passed` }];
}

const TONE_COLOR: Readonly<Record<Tone, string>> = {
    failed: 'var(--color-error)',
    running: 'var(--color-info)',
    queued: 'var(--ag-text-dim)',
    passed: 'var(--ag-text-muted)',
    none: 'var(--ag-text-dim)'
};

const rootStyle = 'display: inline-flex; flex-direction: column; gap: 5px; min-inline-size: 0';
const barStyle = 'display: flex; gap: 2px; inline-size: 96px; block-size: 6px; border-radius: 3px; overflow: hidden; background-color: var(--ag-line-strong)';
const labelStyle = 'font-family: var(--font-mono); font-size: 11px; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis';

export const ChecksBar = component<ChecksBarProps>(({ props }) => () => {
    const n = countChecks(props.checks);
    const running = n.running + n.queued;
    const segment = (kind: string, grow: number, fill: string) => (grow ? <span data-segment={kind} style={`flex-grow: ${grow}; flex-basis: 0; background-color: ${fill}`} /> : null);
    const parts = checksSummary(props.checks);
    return (
        <span data-ag-project="checks-bar" class={props.class} style={rootStyle}>
            <span style={barStyle} aria-hidden="true">
                {segment('passed', n.passed, 'var(--color-primary)')}
                {segment('running', running, 'var(--color-info)')}
                {segment('failed', n.failed, 'var(--color-error)')}
            </span>
            <span data-checks-summary="" style={labelStyle}>
                {parts.flatMap((part, i) => [
                    i ? <span style="color: var(--ag-text-muted)">{' · '}</span> : null,
                    <span data-tone={part.tone} style={`color: ${TONE_COLOR[part.tone]}`}>{part.text}</span>
                ])}
            </span>
        </span>
    );
}, { name: 'ChecksBar' });
