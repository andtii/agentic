/** The step lines a work card, a lane and the follow panel show: `ai-steps` step lines in an `ai-steps` list, reused as they are (#1054). */
import { component, type Define, type JSXElement } from '@sigx/runtime-core';
import type { TranscriptStep } from '@agentic/core';
import { Icon } from '../kit/icons.js';
import { StepLine, type StepHrefFn } from '../transcript/Steps.js';

export type StepListProps =
    & Define.Prop<'steps', readonly TranscriptStep[], true>
    & Define.Prop<'fullHref', StepHrefFn, false>
    & Define.Prop<'now', number, false>;

export const StepList = component<StepListProps>(({ props }) => () => (
    <ol data-scope="ai-steps" data-part="list">
        {props.steps.map((step) => (
            <StepLine key={step.id} step={step} fullHref={props.fullHref} now={props.now} />
        ))}
    </ol>
), { name: 'StepList' });

/**
 * A member's state mark: the turning ring (`i`) while it runs, a check once a card is done
 * (`check`), else a dot (`b`, hollow when idle — the recipe reads the state).
 */
export function markContent(running: boolean, check = false): JSXElement {
    if (running) return <i aria-hidden="true" />;
    return check ? <Icon name="check" size={13} /> : <b aria-hidden="true" />;
}
