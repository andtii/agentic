/**
 * `FailureCard` — one of the six named failure states on zero's
 * `EmptyState` (`docs/design/HANDOFF.md` → "Failure distinction", the
 * bottom of `Foundations`). The title row: 16 px icon in the state colour,
 * the name 14 / 600 in the same colour, a mono signal caption right-aligned;
 * a 13 px detail in text-muted; one action. The colour is the tone's role
 * and the `kind` axis names the state; the name, icon, signal and action
 * come from the shared table, so two kinds can never look alike.
 *
 * The root is `role="status"` named by the state, with `data-kind`,
 * `data-failure` and `data-tone`; the title row's pieces are
 * `data-failure-icon`, `-name` and `-signal`.
 */
import { component, type Define } from '@sigx/runtime-core';
import { EmptyState } from '@sigx/zero';
import { Button } from '../Button.js';
import { Icon } from '../icons.js';
import { roleOf } from '../tone.js';
import { FAILURES, type FailureKind } from './kinds.js';

export interface FailureAction {
    /** Defaults to the table's label for the kind. */
    readonly label?: string;
    /** A link action (`Open machine`, `Open task`). */
    readonly href?: string;
    /** A button action (`Re-check`, `Retry turn`, `Resume`). */
    readonly onAction?: () => void;
    readonly disabled?: boolean;
    readonly loading?: boolean;
}

export type FailureCardProps =
    & Define.Prop<'kind', FailureKind, true>
    /** What happened, in one or two sentences; the table's default otherwise. */
    & Define.Prop<'detail', string>
    /** Override the mono signal caption. */
    & Define.Prop<'signal', string>
    & Define.Prop<'action', FailureAction>
    /** Hide the action row entirely (a card inside a thread that already has Retry). */
    & Define.Prop<'noAction', boolean>
    & Define.Prop<'class', string>;

export const FailureCard = component<FailureCardProps>(({ props }) => () => {
    const spec = FAILURES[props.kind];
    const action = props.action ?? {};
    const label = action.label ?? spec.action;
    const disabled = action.disabled ?? spec.actionDisabled ?? false;
    return (
        <EmptyState.Root color={roleOf(spec.tone)} axes={{ kind: spec.axis }} data-failure={props.kind} data-tone={spec.tone} class={props.class} role="status" aria-label={spec.name}>
            <EmptyState.Title>
                <span data-failure-icon="" aria-hidden="true"><Icon name={spec.icon} size={16} /></span>
                <span data-failure-name="">{spec.name}</span>
                <span data-failure-signal="">{props.signal ?? spec.signal}</span>
            </EmptyState.Title>
            <EmptyState.Description>{props.detail ?? spec.detail}</EmptyState.Description>
            {props.noAction ? null : (
                <EmptyState.Actions>
                    {action.href && !disabled
                        ? <Button href={action.href} intent="default">{label}</Button>
                        : <Button intent="default" disabled={disabled} loading={action.loading} onClick={() => action.onAction?.()}>{label}</Button>}
                </EmptyState.Actions>
            )}
        </EmptyState.Root>
    );
}, { name: 'FailureCard' });
