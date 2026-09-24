/**
 * An update's phases as zero's `Timeline` (#593): the daemon update card's
 * and a runtime's (Downloading → … → Restarting). A finished or current
 * phase has the primary marker, one still to come the neutral one; the
 * current phase is `aria-current="step"` and can carry what it waits on
 * (`detail`: the download's progress, the turns a drain waits for).
 * `data-update-phase` and `data-phase-state` (zero reserves `data-state`) mark each item for page styles and tests.
 */
import { component, type Define, type JSXElement } from 'sigx';
import { Timeline } from '@sigx/zero';

export interface PhaseStep {
    readonly phase: string;
    readonly label: string;
    readonly state: 'done' | 'current' | 'todo';
}

export type PhaseTimelineProps =
    & Define.Prop<'steps', readonly PhaseStep[], true>
    /** The list's accessible name. */
    & Define.Prop<'label', string, true>
    /** Under a phase's label: what it is waiting on. */
    & Define.Prop<'detail', (step: PhaseStep) => JSXElement | null>;

export const PhaseTimeline = component<PhaseTimelineProps>(({ props }) => () => (
    <Timeline.Root data-update-phases="" aria-label={props.label}>
        {props.steps.map((s, i) => (
            <Timeline.Item data-update-phase={s.phase} data-phase-state={s.state} aria-current={s.state === 'current' ? 'step' : undefined}>
                <Timeline.Marker color={s.state === 'todo' ? 'neutral' : 'primary'} />
                <Timeline.Content>
                    <span data-update-phase-label>{s.label}</span>
                    {props.detail?.(s) ?? null}
                </Timeline.Content>
                {i < props.steps.length - 1 ? <Timeline.Connector /> : null}
            </Timeline.Item>
        ))}
    </Timeline.Root>
), { name: 'PhaseTimeline' });
