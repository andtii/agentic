/**
 * `TimelineList` — task transitions on zero's `Timeline`
 * (`docs/design/HANDOFF.md` → "Components"): an 8 px dot in the state
 * colour, a 1 px `line-strong` connector, text 13 and the time in mono 11.
 * Each entry's tone paints its marker through the timeline's accent token.
 */
import { component, type Define } from '@sigx/runtime-core';
import { Timeline } from '@sigx/zero';
import type { Tone } from './vocabulary.js';

export interface TimelineEntry {
    readonly id: string;
    readonly text: string;
    /** Already formatted in the workspace zone. */
    readonly time: string;
    readonly tone?: Tone;
}

const toneInk: Record<Tone, string> = {
    muted: 'var(--ag-text-muted)',
    dim: 'var(--ag-text-dim)',
    live: 'var(--color-primary)',
    working: 'var(--color-info)',
    'needs-you': 'var(--color-warning)',
    failed: 'var(--color-error)'
};

export type TimelineListProps =
    & Define.Prop<'entries', readonly TimelineEntry[], true>
    & Define.Prop<'label', string>
    & Define.Prop<'class', string>;

export const TimelineList = component<TimelineListProps>(({ props }) => () => (
    <Timeline.Root orientation="vertical" class={props.class}>
        {props.entries.map((entry) => (
            <Timeline.Item>
                <Timeline.Marker>
                    <span data-tone={entry.tone ?? 'muted'} style={`display: block; inline-size: 8px; block-size: 8px; border-radius: 50%; background: ${toneInk[entry.tone ?? 'muted']}`} aria-hidden="true" />
                </Timeline.Marker>
                <Timeline.Content>
                    <span data-timeline-text="">{entry.text}</span>{' '}
                    <time data-timeline-time="" style="font-family: var(--font-mono); font-size: var(--text-xs); color: var(--ag-text-dim)">{entry.time}</time>
                </Timeline.Content>
            </Timeline.Item>
        ))}
    </Timeline.Root>
), { name: 'TimelineList' });
