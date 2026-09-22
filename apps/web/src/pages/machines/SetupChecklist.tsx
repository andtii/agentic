/**
 * The setup checklist under the machine's header (#482): the five steps of
 * `setupSteps`, done ones folded to a tick and a word, the current one open
 * with its note and its one action, the rest dim. Once every step is done
 * it is a single line.
 */
import { component, type Define, type JSXElement } from 'sigx';
import { Button, Icon } from '@agentic/ui';
import type { SetupStep, SetupStepId } from './setup';

export type SetupChecklistProps =
    & Define.Prop<'steps', readonly SetupStep[], true>
    /** The action of a step is offline-safe or not: the page says which are usable now. */
    & Define.Prop<'disabled', readonly SetupStepId[]>
    & Define.Event<'action', SetupStepId>;

export const SetupChecklist = component<SetupChecklistProps>(({ props, emit }) => {
    return (): JSXElement => {
        const steps = props.steps;
        const complete = steps.every((s) => s.state === 'done');
        const current = steps.find((s) => s.state === 'current');
        return (
            <section data-setup-checklist data-setup-complete={complete ? '' : undefined} aria-label="Setup" data-setup-current={current?.id}>
                <ol data-setup-steps>
                    {steps.map((s, i) => (
                        <li data-setup-step={s.id} data-state={s.state} aria-current={s.state === 'current' ? 'step' : undefined}>
                            <span data-setup-marker aria-hidden="true">{s.state === 'done' ? <Icon name="check" size={13} /> : String(i + 1)}</span>
                            <span data-setup-label>{s.label}</span>
                            {s.state === 'current' ? (
                                <span data-setup-body>
                                    <span data-setup-note>{s.note}</span>
                                    {s.action ? <Button intent="primary" disabled={props.disabled?.includes(s.id)} onClick={() => emit('action', s.id)}>{s.action}</Button> : null}
                                </span>
                            ) : null}
                        </li>
                    ))}
                </ol>
                {complete ? <span data-setup-done>Set up — every step is done.</span> : null}
            </section>
        );
    };
});
