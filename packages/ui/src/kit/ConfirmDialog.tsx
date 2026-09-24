/**
 * `ConfirmDialog` — the destructive confirm on zero's `Dialog` alert-dialog
 * preset (`docs/design/HANDOFF.md` → "Components", "Accessibility"): 520 px
 * on base-300 (the dialog recipe), `role="alertdialog"`, focus trapped,
 * Escape closes, focus returns to the trigger, default focus on the
 * non-destructive button (zero's `Dialog.Cancel`). It must list every
 * dependent by name before the destructive button, and the button states
 * the consequence ("Disable and stop 2 sessions").
 */
import { component, type Define } from '@sigx/runtime-core';
import { Dialog, type DialogCloseDetail } from '@sigx/zero';
import { Button } from './Button.js';

export type ConfirmDialogProps =
    & Define.Model<boolean>
    & Define.Prop<'title', string, true>
    & Define.Prop<'description', string>
    /** Everything the action affects, by name — listed before the button. */
    & Define.Prop<'dependents', readonly string[]>
    & Define.Prop<'dependentsLabel', string>
    /** States the consequence: "Disable and stop 2 sessions". */
    & Define.Prop<'confirmLabel', string, true>
    & Define.Prop<'cancelLabel', string>
    /** A non-destructive confirm uses the primary intent instead of danger. */
    & Define.Prop<'danger', boolean>
    & Define.Prop<'busy', boolean>
    & Define.Event<'confirm', void>
    & Define.Event<'cancel', void>
    /** The trigger, if the dialog owns one. */
    & Define.Slot<'trigger'>
    & Define.Slot<'default'>;

export const ConfirmDialog = component<ConfirmDialogProps>(({ props, slots, emit }) => {
    // A close the caller makes after `confirm` (writing the model) is zero's
    // `programmatic` close, not a cancel: Cancel, Escape and the backdrop are.
    const onClose = (d: DialogCloseDetail): void => {
        if (d.reason !== 'programmatic') emit('cancel');
    };
    return () => {
        const dependents = props.dependents ?? [];
        return (
        <Dialog.Root model={props.model} role="alertdialog" modal onClose={onClose}>
            {slots.trigger ? <Dialog.Trigger asChild>{(part) => <span {...part}>{slots.trigger?.()}</span>}</Dialog.Trigger> : null}
            <Dialog.Popup>
                <Dialog.Title>{props.title}</Dialog.Title>
                {props.description ? <Dialog.Description>{props.description}</Dialog.Description> : null}
                {dependents.length ? (
                    <div data-confirm-dependents="">
                        <p>
                            {props.dependentsLabel ?? `Affects ${dependents.length}`}
                        </p>
                        <ul>
                            {dependents.map((name) => <li>{name}</li>)}
                        </ul>
                    </div>
                ) : null}
                {slots.default?.()}
                <Dialog.Footer>
                    <Dialog.Cancel>{props.cancelLabel ?? 'Cancel'}</Dialog.Cancel>
                    <Button intent={props.danger === false ? 'primary' : 'danger'} confirm loading={props.busy} onClick={() => emit('confirm')}>
                        {props.confirmLabel}
                    </Button>
                </Dialog.Footer>
            </Dialog.Popup>
        </Dialog.Root>
    );
    };
}, { name: 'ConfirmDialog' });
