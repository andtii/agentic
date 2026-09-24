/**
 * The dialogs on zero's close event: ConfirmDialog's `cancel` is every close
 * the caller did not make (Cancel, Escape) and never the caller closing after
 * a confirm; FormDialog is a plain dialog around a real form — Enter submits,
 * `required` blocks, the submit keeps it open, and Close / Escape cancel.
 */
import { describe, it, expect } from 'vitest';
import { signal } from '@sigx/runtime-core';
import { ConfirmDialog, FormDialog } from '@agentic/ui';
import { buttonNamed, mount, one, tick } from '../helpers';

const popupOf = (root: ParentNode): HTMLDialogElement => one(root, 'dialog', 'popup') as HTMLDialogElement;

/** What the platform fires on Escape in a modal `<dialog>`. */
function escape(popup: HTMLDialogElement): void {
    popup.dispatchEvent(new Event('cancel', { cancelable: true }));
}

describe('ConfirmDialog', () => {
    function mountConfirm() {
        const state = signal({ open: true });
        const events: string[] = [];
        const root = mount(
            <ConfirmDialog model={() => state.open} title="Delete Forge?" confirmLabel="Delete" onConfirm={() => events.push('confirm')} onCancel={() => events.push('cancel')} />
        );
        return { state, events, root };
    }

    it('cancels on Escape', async () => {
        const { state, events, root } = mountConfirm();
        await tick();
        escape(popupOf(root));
        await tick();
        expect(state.open).toBe(false);
        expect(events).toEqual(['cancel']);
    });

    it('a confirm does not close it; the caller closing afterwards is not a cancel, and a reopen cancels again', async () => {
        const { state, events, root } = mountConfirm();
        await tick();
        buttonNamed(popupOf(root), 'Delete').click();
        await tick();
        expect(state.open).toBe(true);
        state.open = false;
        await tick();
        expect(events).toEqual(['confirm']);
        state.open = true;
        await tick();
        escape(popupOf(root));
        await tick();
        expect(events).toEqual(['confirm', 'cancel']);
    });
});

describe('FormDialog', () => {
    function mountForm(busy = false) {
        const state = signal({ open: true, name: '', busy });
        const events: string[] = [];
        const root = mount(
            <FormDialog
                model={() => state.open}
                title="New schedule"
                description="Runs on the workspace's time zone."
                submitLabel="Create"
                busy={state.busy}
                onSubmit={() => events.push('submit')}
                onCancel={() => events.push('cancel')}
            >
                <label>
                    Name
                    <input name="name" required value={state.name} onInput={(e: Event) => { state.name = (e.target as HTMLInputElement).value; }} />
                </label>
            </FormDialog>
        );
        return { state, events, root };
    }

    it('is a plain dialog (not the alert preset) wrapping a form, the fields before Cancel and the submit', async () => {
        const { root } = mountForm();
        await tick();
        const popup = popupOf(root);
        expect(popup.getAttribute('role')).not.toBe('alertdialog');
        expect(one(popup, 'dialog', 'title')!.textContent).toBe('New schedule');
        expect(one(popup, 'dialog', 'description')!.textContent).toBe("Runs on the workspace's time zone.");
        const form = popup.querySelector('form[data-form-dialog]')!;
        const cancel = buttonNamed(form, 'Cancel');
        expect(cancel.getAttribute('data-part')).toBe('close');
        // Nothing takes initial focus from the first field.
        expect(cancel.hasAttribute('autofocus')).toBe(false);
        const create = buttonNamed(form, 'Create');
        expect(create.getAttribute('type')).toBe('submit');
        expect(create.getAttribute('data-intent')).toBe('primary');
        expect(form.querySelector('input')!.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('`required` blocks the submit; a valid submit emits and stays open until the caller closes it', async () => {
        const { state, events, root } = mountForm();
        await tick();
        const form = popupOf(root).querySelector('form')!;
        form.requestSubmit();
        await tick();
        expect(events).toEqual([]);
        const input = form.querySelector('input')!;
        input.value = 'Nightly';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        // Enter in a field submits through the form's submit button (implicit submission).
        form.requestSubmit(buttonNamed(form, 'Create'));
        await tick();
        expect(events).toEqual(['submit']);
        expect(state.open).toBe(true);
        state.open = false;
        await tick();
        expect(events).toEqual(['submit']);
    });

    it('while busy the submit is loading and a second submit is ignored', async () => {
        const { events, root } = mountForm(true);
        await tick();
        const form = popupOf(root).querySelector('form')!;
        const create = buttonNamed(form, 'Create');
        expect(create.getAttribute('data-state')).toBe('loading');
        expect(create.getAttribute('aria-disabled')).toBe('true');
        const input = form.querySelector('input')!;
        input.value = 'Nightly';
        form.requestSubmit();
        await tick();
        expect(events).toEqual([]);
    });

    it('cancels on Close and on Escape', async () => {
        const { state, events, root } = mountForm();
        await tick();
        buttonNamed(popupOf(root), 'Cancel').click();
        await tick();
        expect(state.open).toBe(false);
        expect(events).toEqual(['cancel']);
        state.open = true;
        await tick();
        escape(popupOf(root));
        await tick();
        expect(state.open).toBe(false);
        expect(events).toEqual(['cancel', 'cancel']);
    });
});
