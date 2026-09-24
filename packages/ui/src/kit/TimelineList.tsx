/**
 * `TimelineList` — task transitions on zero's `Timeline`
 * (`docs/design/HANDOFF.md` → "Components"): an 8 px dot in the state
 * colour, a 1 px `line-strong` connector, text 13 and the time in mono 11.
 * Each entry's tone is its marker's `color` (the tone's role); the marker
 * keeps `data-tone`, and the design system's timeline patch draws the dot
 * and the time.
 */
import { component, type Define } from '@sigx/runtime-core';
import { Timeline } from '@sigx/zero';
import { roleOf } from './tone.js';
import type { Tone } from './vocabulary.js';

export interface TimelineEntry {
    readonly id: string;
    readonly text: string;
    /** Already formatted in the workspace zone. */
    readonly time: string;
    readonly tone?: Tone;
}

export type TimelineListProps =
    & Define.Prop<'entries', readonly TimelineEntry[], true>
    /** The list's accessible name. */
    & Define.Prop<'label', string>
    & Define.Prop<'class', string>;

export const TimelineList = component<TimelineListProps>(({ props }) => () => (
    <Timeline.Root orientation="vertical" aria-label={props.label} class={props.class}>
        {props.entries.map((entry) => (
            <Timeline.Item key={entry.id}>
                <Timeline.Marker color={roleOf(entry.tone ?? 'muted')} data-tone={entry.tone ?? 'muted'} />
                <Timeline.Content>
                    <span data-timeline-text="">{entry.text}</span>{' '}
                    <time data-timeline-time="">{entry.time}</time>
                </Timeline.Content>
            </Timeline.Item>
        ))}
    </Timeline.Root>
), { name: 'TimelineList' });
