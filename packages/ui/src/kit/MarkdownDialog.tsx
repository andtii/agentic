/**
 * `MarkdownDialog` — a document read full-size (#490): zero's `Dialog`
 * widened to 880 px with a `MarkdownViewer` scrolling inside it, a `footer`
 * slot for the actions the document calls for (a plan's approvals) and a
 * `Close`. Like `ConfirmDialog` it carries no scope of its own; the popup is
 * sized by `kitCss` through the `data-ag-document` marker.
 *
 * The dialog never decides anything: the footer's buttons are the caller's.
 * Every close — Close, Escape, the backdrop, or the model set false after a
 * footer action — emits `close`; a caller that acted knows it did.
 */
import { component, type Define } from '@sigx/runtime-core';
import { Dialog } from '@sigx/zero';
import type { DomLinkHandler } from '@sigx/markdown/dom';
import type { CodeHighlighter } from '@sigx/markdown/shiki';
import { MarkdownViewer } from './MarkdownViewer.js';

export type MarkdownDialogProps =
    & Define.Model<boolean>
    & Define.Prop<'title', string, true>
    & Define.Prop<'value', string, true>
    & Define.Prop<'onLink', DomLinkHandler, false>
    & Define.Prop<'highlighter', CodeHighlighter | false, false>
    & Define.Prop<'closeLabel', string, false>
    & Define.Event<'close', void>
    /** The document's actions, before Close. */
    & Define.Slot<'footer'>;

export const MarkdownDialog = component<MarkdownDialogProps>(({ props, slots, emit }) => {
    const onOpenChange = (open: boolean): void => {
        if (!open) emit('close');
    };
    return () => (
        <Dialog.Root model={props.model} modal onOpenChange={onOpenChange}>
            <Dialog.Popup>
                <div data-ag-document="">
                    <Dialog.Title>{props.title}</Dialog.Title>
                    <div data-ag-document-body="">
                        <MarkdownViewer value={props.value} onLink={props.onLink} highlighter={props.highlighter} />
                    </div>
                    <Dialog.Footer>
                        {slots.footer?.()}
                        <Dialog.Close>{props.closeLabel ?? 'Close'}</Dialog.Close>
                    </Dialog.Footer>
                </div>
            </Dialog.Popup>
        </Dialog.Root>
    );
}, { name: 'MarkdownDialog' });
