/**
 * "Confirm with GitHub to continue" (#355): shown when an actor call was
 * refused `elevation-required`. Continue puts the change aside
 * (`savePending`) and sends the browser through `/auth/elevate`; back on the
 * page, the same dialog reopens in its `resume` shape — the change is named
 * and one **Confirm** click sends it. Nothing is sent without that click.
 */
import { component, type Define, type JSXElement } from 'sigx';
import { ConfirmDialog } from '@agentic/ui';
import { describePending, type PendingKind } from './elevate';

export type ElevateDialogProps =
    & Define.Model<boolean>
    & Define.Prop<'kind', PendingKind, true>
    & Define.Prop<'machineName', string, true>
    /** `resume`: the round trip is done, the change waits for its click. */
    & Define.Prop<'resume', boolean>
    & Define.Prop<'busy', boolean>
    & Define.Event<'continue', void>
    & Define.Event<'confirm', void>
    & Define.Event<'cancel', void>
    & Define.Slot<'default'>;

export const ElevateDialog = component<ElevateDialogProps>(({ props, slots, emit }) => {
    return (): JSXElement => {
        const text = describePending(props.kind, props.machineName);
        const resume = props.resume === true;
        return (
            <ConfirmDialog
                model={props.model}
                title={resume ? 'Confirmed — apply the change?' : text.title}
                description={resume ? `You signed in again. Confirm to ${text.what} now — nothing was changed yet.` : text.description}
                confirmLabel={resume ? 'Confirm' : text.confirmLabel}
                cancelLabel="Not now"
                danger={props.kind === 'revoke' || props.kind === 'remove'}
                busy={props.busy === true}
                onConfirm={() => emit(resume ? 'confirm' : 'continue')}
                onCancel={() => emit('cancel')}
            >
                {slots.default?.()}
            </ConfirmDialog>
        );
    };
});
