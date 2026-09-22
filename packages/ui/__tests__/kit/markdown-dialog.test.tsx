/**
 * The document dialog (#490): a modal with the title, the document as
 * markdown in a scrolling body, the caller's footer actions before Close;
 * every close emits `close`.
 */
import { describe, it, expect } from 'vitest';
import { signal } from '@sigx/runtime-core';
import { Button, MarkdownDialog } from '@agentic/ui';
import { buttonNamed, mount, one, tick } from '../helpers';

describe('MarkdownDialog', () => {
    it('shows the title and the document, the footer slot before Close, and reports a close', async () => {
        const state = signal({ open: true });
        const events: string[] = [];
        const root = mount(
            <MarkdownDialog
                model={() => state.open}
                title="Plan"
                value={'## Steps\n\n1. one\n2. two'}
                highlighter={false}
                onClose={() => events.push('close')}
                slots={{ footer: () => <Button intent="wait" onClick={() => events.push('approve')}>Approve</Button> }}
            />
        );
        await tick();
        const popup = root.querySelector('[data-scope="dialog"][data-part="popup"]')!;
        // A plain dialog, not the alert preset: a backdrop click may dismiss it.
        expect(popup.getAttribute('role')).not.toBe('alertdialog');
        expect(popup.querySelector('[data-ag-document]')).not.toBeNull();
        expect(one(popup, 'dialog', 'title')!.textContent).toBe('Plan');
        const body = popup.querySelector('[data-ag-document-body]')!;
        expect(one(body, 'ag-markdown', 'root')).not.toBeNull();
        expect(body.querySelector('h2')!.textContent).toBe('Steps');
        expect([...body.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['one', 'two']);

        const approve = buttonNamed(popup, 'Approve');
        const close = buttonNamed(popup, 'Close');
        expect(close.getAttribute('data-part')).toBe('close');
        expect(approve.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        approve.click();
        expect(events).toEqual(['approve']);

        close.click();
        await tick();
        expect(state.open).toBe(false);
        expect(events).toEqual(['approve', 'close']);
    });
});
