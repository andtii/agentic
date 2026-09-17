/**
 * `FailureCard` — one of the six named failure states on the `ag-failure`
 * scope (`docs/design/HANDOFF.md` → "Failure distinction", the bottom of
 * `Foundations`). Header: 16 px icon in the state colour, the name 14 / 600
 * in the same colour, a mono signal caption right-aligned; a 13 px detail in
 * text-muted; one action. The `kind` axis paints it; the name, icon, signal
 * and action come from the shared table, so two kinds can never look alike.
 */
import { component, type Define } from '@sigx/runtime-core';
import { agFailureAnatomy } from '../anatomy.js';
import { Button } from '../Button.js';
import { Icon } from '../icons.js';
import { FAILURES, type FailureKind } from './kinds.js';

const SCOPE = agFailureAnatomy.scope;

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
        <article data-scope={SCOPE} data-part="root" data-kind={spec.axis} data-failure={props.kind} data-tone={spec.tone} class={props.class} role="status" aria-label={spec.name}>
            <div data-scope={SCOPE} data-part="header">
                <span data-scope={SCOPE} data-part="icon"><Icon name={spec.icon} size={16} /></span>
                <span data-scope={SCOPE} data-part="name">{spec.name}</span>
                <span data-scope={SCOPE} data-part="signal">{props.signal ?? spec.signal}</span>
            </div>
            <p data-scope={SCOPE} data-part="detail">{props.detail ?? spec.detail}</p>
            {props.noAction ? null : (
                <div data-scope={SCOPE} data-part="actions">
                    {action.href && !disabled
                        ? <a href={action.href} data-scope="button" data-part="root" data-color="neutral" data-variant="solid" data-intent="default"><span>{label}</span></a>
                        : <Button intent="default" disabled={disabled} loading={action.loading} onClick={() => action.onAction?.()}>{label}</Button>}
                </div>
            )}
        </article>
    );
}, { name: 'FailureCard' });
