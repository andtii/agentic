/**
 * `FormDialog` — data entry in a dialog: zero's plain modal `Dialog` (role
 * `dialog`, not the alert preset) around a real `<form>`, so Enter in a field
 * submits and `required` blocks the submit through the platform. Nothing
 * autofocuses the Cancel, so focus lands on the first field.
 *
 * `submit` fires on a valid submit (the default is prevented) and the dialog
 * stays open: the caller saves, shows `busy`, and closes by writing the
 * model. `cancel` fires on every close the caller did not make — Cancel,
 * Escape, the backdrop. `ConfirmDialog` stays the destructive confirm.
 *
 * Like `ConfirmDialog` it carries no scope of its own; the form is marked
 * `data-form-dialog` for page styles and tests.
 */
import { component, type Define } from '@sigx/runtime-core';
import { Dialog, type DialogCloseDetail } from '@sigx/zero';
import { Button } from './Button.js';

export type FormDialogProps =
    & Define.Model<boolean>
    & Define.Prop<'title', string, true>
    & Define.Prop<'description', string>
    /** The submit button's label; "Save" by default. */
    & Define.Prop<'submitLabel', string>
    & Define.Prop<'cancelLabel', string>
    /** The save in flight: the submit shows zero's loading state and a second submit is ignored. */
    & Define.Prop<'busy', boolean>
    /** The form's `id`, for controls that post to it from outside. */
    & Define.Prop<'id', string>
    & Define.Event<'submit', SubmitEvent | Event>
    & Define.Event<'cancel', void>
    /** The fields. */
    & Define.Slot<'default'>;

export const FormDialog = component<FormDialogProps>(({ props, slots, emit }) => {
    const onClose = (d: DialogCloseDetail): void => {
        if (d.reason !== 'programmatic') emit('cancel');
    };
    const onSubmit = (e: Event): void => {
        e.preventDefault();
        if (props.busy) return;
        emit('submit', e);
    };
    return () => (
        <Dialog.Root model={props.model} modal onClose={onClose}>
            <Dialog.Popup>
                <form id={props.id} data-form-dialog="" onSubmit={onSubmit}>
                    <Dialog.Title>{props.title}</Dialog.Title>
                    {props.description ? <Dialog.Description>{props.description}</Dialog.Description> : null}
                    {slots.default?.()}
                    <Dialog.Footer>
                        <Dialog.Close value="cancel">{props.cancelLabel ?? 'Cancel'}</Dialog.Close>
                        <Button type="submit" intent="primary" loading={props.busy}>
                            {props.submitLabel ?? 'Save'}
                        </Button>
                    </Dialog.Footer>
                </form>
            </Dialog.Popup>
        </Dialog.Root>
    );
}, { name: 'FormDialog' });
