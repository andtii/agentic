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
import { watch } from '@sigx/reactivity';
import { Dialog } from '@sigx/zero';
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
    // A close after `confirm` is the caller finishing, not a cancel: only a
    // close that no confirm preceded (Cancel, Escape, backdrop) emits `cancel`.
    let confirmed = false;
    // Opening resets the flag — through the model (a page reopening it) or zero's own change.
    watch(() => props.model?.value, (open) => { if (open) confirmed = false; });
    const onOpenChange = (open: boolean): void => {
        if (open) confirmed = false;
        else if (!confirmed) emit('cancel');
    };
    const confirm = (): void => {
        confirmed = true;
        emit('confirm');
    };
    return () => {
        const dependents = props.dependents ?? [];
        return (
        <Dialog.Root model={props.model} role="alertdialog" modal onOpenChange={onOpenChange}>
            {slots.trigger ? <Dialog.Trigger asChild>{(part) => <span {...part}>{slots.trigger?.()}</span>}</Dialog.Trigger> : null}
            <Dialog.Popup>
                <Dialog.Title>{props.title}</Dialog.Title>
                {props.description ? <Dialog.Description>{props.description}</Dialog.Description> : null}
                {dependents.length ? (
                    <div data-confirm-dependents="">
                        <p style="margin: 0 0 var(--space-xs); font-family: var(--font-mono); font-size: var(--text-xs); letter-spacing: var(--tracking-wider); text-transform: uppercase; color: var(--ag-text-dim)">
                            {props.dependentsLabel ?? `Affects ${dependents.length}`}
                        </p>
                        <ul style="margin: 0 0 var(--space-lg); padding-inline-start: var(--space-lg); font-size: var(--text-md)">
                            {dependents.map((name) => <li>{name}</li>)}
                        </ul>
                    </div>
                ) : null}
                {slots.default?.()}
                <Dialog.Footer>
                    <Dialog.Cancel>{props.cancelLabel ?? 'Cancel'}</Dialog.Cancel>
                    <Button intent={props.danger === false ? 'primary' : 'danger'} confirm loading={props.busy} onClick={confirm}>
                        {props.confirmLabel}
                    </Button>
                </Dialog.Footer>
            </Dialog.Popup>
        </Dialog.Root>
    );
    };
}, { name: 'ConfirmDialog' });
