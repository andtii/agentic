/**
 * `Composer` — the prompt box (`ai-composer`, `docs/design/HANDOFF.md` →
 * `ai-composer`): the addressing row ("To" + recipient chips + hint), zero's
 * `Textarea` autosizing between `minRows` and `maxRows`, an `@mention` popup
 * (zero's `Combobox` in trigger mode around the textarea), the attachments
 * strip, and the action row — attach, the key hint, Cancel while a turn can
 * be cancelled, `Send` primary.
 *
 * Enter sends, Shift+Enter breaks a line, and an IME composition's Enter
 * belongs to the composition — the textarea's own `onKeydown`. While the
 * mention popup is open its keys come first (zero runs them before
 * `onKeydown`): Enter or Tab picks the highlighted mention and does not
 * send, the arrows move, Escape dismisses. The popup lists at most
 * `MAX_MENTIONS`, prefix matches before substring ones (`filterMentions`).
 *
 * While a turn runs Send stays enabled only when the agent can be steered
 * (`steers`), and Cancel appears only when it can be cancelled
 * (`canCancel`) — capabilities, never who the agent is. Who the message goes to is the page's resolution (mentions ∩
 * members, else the coordinator, else the single member, else nobody) —
 * this component only shows it.
 *
 * Files come in three ways — the Attach button's hidden
 * `<input type=file multiple>`, a paste carrying `clipboardData.files`, and
 * a drag-and-drop onto the card — and all three emit one `files` event with
 * a `File[]`. The composer never uploads: the host turns files into
 * `attachments` (with a `status`) and the strip renders them — a thumbnail
 * when there is a `previewUrl`, a spinner while `uploading`, the error note
 * on `error`, and a remove button. Send waits while any chip is uploading
 * and goes with an empty draft when there are attachments. While a drag
 * carrying files hovers, the root carries zero's governed `highlighted`
 * flag — zero's own `FileUpload` spells drag-over the same way, and the
 * flag vocabulary is closed (no `data-dragging`).
 *
 * A host puts text into the draft with `insert` (#565: "Mention in chat"
 * drops `@file:<path>` in): each new `id` appends its `text` to the draft,
 * spaced, with the caret after it — also on mount, so a page opened with
 * a prefill starts with it. The composer still owns the draft; `draft`
 * reports every change an insert makes, as typing does through `input`.
 */
import { component, type Define } from '@sigx/runtime-core';
import { watch } from '@sigx/reactivity';
import { Combobox, Kbd, Textarea, dataAttr, type TextareaHandle } from '@sigx/zero';
import { caretAnchor } from '@sigx/zero/behaviors';
import { AgentTile, type AgentHue } from '../kit/AgentTile.js';
import { Button } from '../kit/Button.js';
import { ErrorNote } from '../kit/ErrorNote.js';
import { Icon } from '../kit/icons.js';
import { formatBytes } from '../thread/text.js';
import { aiComposerAnatomy } from './anatomy.js';
import { filterMentions, type Mention } from './mentions.js';

const SCOPE = aiComposerAnatomy.scope;

/** Where one attachment is in the host's upload. */
export type AttachmentStatus = 'uploading' | 'ready' | 'error';

/** One chip in the attachments strip — the host's view of a file it took from `files`. */
export interface Attachment {
    readonly id: string;
    readonly name: string;
    /** Bytes; rendered human-readable. */
    readonly size?: number;
    /** `ready` when absent. */
    readonly status?: AttachmentStatus;
    /** Why the upload failed — shown on an `error` chip. */
    readonly error?: string;
    /** A thumbnail (an object URL for an image) — shown in place of the file icon. */
    readonly previewUrl?: string;
}

/** The chip's governed `data-state` per upload status. */
export const ATTACHMENT_STATE = { uploading: 'loading', ready: 'complete', error: 'error' } as const;

/** Does a drag carry files (as opposed to text or a link)? */
const carriesFiles = (e: DragEvent): boolean => {
    const types = e.dataTransfer?.types;
    return !!types && Array.from(types).includes('Files');
};

/** Who a message will activate — one chip in the "To" row. */
export interface Recipient {
    readonly id: string;
    readonly name: string;
    readonly hue?: AgentHue;
    /** The role caption after the chip (`coordinator`). */
    readonly role?: string;
}

/** Text a host puts into the draft; a new `id` inserts again (the same text twice is two inserts). */
export interface ComposerInsert {
    readonly id: string | number;
    readonly text: string;
}

/** The draft with `text` appended — a space between when the draft does not already end in one. */
export function appendToDraft(draft: string, text: string): string {
    if (!text) return draft;
    return draft && !/\s$/.test(draft) ? `${draft} ${text}` : `${draft}${text}`;
}

/** The hint when nobody would answer. */
export const NOBODY_HINT = 'nobody will answer';

export type ComposerProps =
    /** The text to send — trimmed; empty only when attachments go on their own. */
    & Define.Event<'send', string>
    /** Files taken by the picker, a paste or a drop — the host uploads them and hands back `attachments`. */
    & Define.Event<'files', File[]>
    /** Cancel the running turn. */
    & Define.Event<'cancel'>
    /** Remove one attachment by id. */
    & Define.Event<'removeAttachment', string>
    /** The attach button was pressed; the composer opens its own picker as well. */
    & Define.Event<'attach'>
    /** The draft after an `insert` changed it (typing reports through the DOM's `input` event). */
    & Define.Event<'draft', string>
    /** A turn is running or awaiting. */
    & Define.Prop<'busy', boolean, false>
    /** `capabilities.steer` — a prompt during a turn lands inside it. */
    & Define.Prop<'steers', boolean, false>
    /** `capabilities.cancel`. */
    & Define.Prop<'canCancel', boolean, false>
    & Define.Prop<'disabled', boolean, false>
    & Define.Prop<'placeholder', string, false>
    /** Who will be activated by this message; an empty list says nobody will answer. Omit to hide the row. */
    & Define.Prop<'recipients', readonly Recipient[], false>
    /** The right-aligned hint on the addressing row — `Atlas answers unless you @ someone`. */
    & Define.Prop<'hint', string, false>
    /** Who can be mentioned with `@`. */
    & Define.Prop<'mentions', readonly Mention[], false>
    /** The chips — the host's upload state for the files it took from `files`. */
    & Define.Prop<'attachments', readonly Attachment[], false>
    /** The picker's `accept` filter (`image/*,.pdf`); anything by default. */
    & Define.Prop<'accept', string, false>
    /** Text to put into the draft (`@file:<path> `); each new `id` inserts once. */
    & Define.Prop<'insert', ComposerInsert, false>
    /** Autosize bounds in rows (`Textarea.Root minRows` / `maxRows`). Default 1–8. */
    & Define.Prop<'minRows', number, false>
    & Define.Prop<'maxRows', number, false>;

const mentionKey = (m: Mention): string => m.id;
const mentionLabel = (m: Mention): string => m.label;

export const Composer = component<ComposerProps>(({ props, emit, signal }) => {
    /** `query` is the mention token at the caret — the Combobox's `inputValue`. */
    const st = signal({ draft: '', query: '', dragging: false });
    let box: TextareaHandle | null = null;
    let picker: HTMLInputElement | null = null;
    /** `dragenter` / `dragleave` fire per child crossed — a depth count says when the drag really left. */
    let dragDepth = 0;

    const uploading = (): boolean => props.attachments?.some((a) => a.status === 'uploading') === true;
    const hasAttachments = (): boolean => (props.attachments?.length ?? 0) > 0;
    const canSend = (): boolean => !props.disabled && !uploading() && (!props.busy || props.steers === true);

    /** Emit `files` for a non-empty list; says whether it did. */
    const take = (list: FileList | readonly File[] | null | undefined): boolean => {
        const files = list ? Array.from(list) : [];
        if (files.length === 0 || props.disabled) return false;
        emit('files', files);
        return true;
    };

    const onPaste = (e: ClipboardEvent): void => {
        const data = e.clipboardData;
        // Plain text pastes as usual; a paste of only files must not drop anything into the draft.
        if (take(data?.files) && !Array.from(data?.types ?? []).includes('text/plain')) e.preventDefault();
    };

    const onDragenter = (e: DragEvent): void => {
        if (props.disabled || !carriesFiles(e)) return;
        e.preventDefault();
        dragDepth++;
        st.dragging = true;
    };
    const onDragover = (e: DragEvent): void => {
        if (props.disabled || !carriesFiles(e)) return;
        // Without this the browser opens the file instead of dropping it here.
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onDragleave = (): void => {
        if (!st.dragging) return;
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) st.dragging = false;
    };
    const onDrop = (e: DragEvent): void => {
        dragDepth = 0;
        st.dragging = false;
        if (props.disabled || !carriesFiles(e)) return;
        e.preventDefault();
        take(e.dataTransfer?.files);
    };

    const openPicker = (): void => {
        emit('attach');
        picker?.click();
    };

    /** The popup's list, ranked and capped here — the Combobox shows it as given (`filter={false}`). */
    const mentionItems = (): Mention[] => (props.mentions?.length ? filterMentions(props.mentions, st.query) : []);

    const send = (): void => {
        const text = st.draft.trim();
        if ((!text && !hasAttachments()) || !canSend()) return;
        st.draft = '';
        emit('send', text);
        // The composer keeps focus after send.
        box?.focus();
    };

    /** Enter sends, Shift+Enter is a newline, a composition's Enter is the IME's. The open popup's keys never get here. */
    const onKeydown = (e: KeyboardEvent): void => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            send();
        }
    };

    // A host's insert: appended, caret after it, focus in the box; the host hears the new draft.
    let insertedId: string | number | undefined;
    watch(
        () => props.insert,
        (insert) => {
            if (!insert || insert.id === insertedId) return;
            insertedId = insert.id;
            const text = insert.text;
            if (!text) return;
            st.draft = appendToDraft(st.draft, text);
            emit('draft', st.draft);
            queueMicrotask(() => {
                const el = box?.element;
                if (!el) return;
                // The page arrived with the insert: focus the box without scrolling the page to it.
                box?.focus({ preventScroll: true });
                el.setSelectionRange(el.value.length, el.value.length);
            });
        },
        { immediate: true }
    );

    return () => {
        const busy = props.busy === true;
        const recipients = props.recipients;
        const hint = recipients ? (props.hint ?? (recipients.length === 0 ? NOBODY_HINT : undefined)) : undefined;
        return (
            <form
                data-scope={SCOPE}
                data-part="root"
                data-highlighted={dataAttr(st.dragging)}
                onSubmit={(e: Event) => {
                    e.preventDefault();
                    send();
                }}
                onPaste={onPaste}
                onDragenter={onDragenter}
                onDragover={onDragover}
                onDragleave={onDragleave}
                onDrop={onDrop}
            >
                {recipients && (
                    <div data-scope={SCOPE} data-part="addressing">
                        <span>To</span>
                        {recipients.map((r) => (
                            <span key={r.id} data-scope={SCOPE} data-part="recipient">
                                <AgentTile name={r.name} hue={r.hue} size={18} />
                                <span>{r.name}</span>
                                {r.role && <small>{r.role}</small>}
                            </span>
                        ))}
                        {hint && (
                            <span data-scope={SCOPE} data-part="hint" data-nobody={dataAttr(recipients.length === 0)}>
                                {hint}
                            </span>
                        )}
                    </div>
                )}
                {props.attachments && props.attachments.length > 0 && (
                    <ul data-scope={SCOPE} data-part="attachments">
                        {props.attachments.map((a) => {
                            const status = a.status ?? 'ready';
                            return (
                                <li key={a.id} data-scope={SCOPE} data-part="attachment" data-state={ATTACHMENT_STATE[status]} aria-busy={status === 'uploading' ? 'true' : undefined}>
                                    {a.previewUrl ? <img data-scope={SCOPE} data-part="thumbnail" src={a.previewUrl} alt="" /> : <Icon name="file" size={14} />}
                                    <span data-scope={SCOPE} data-part="attachment-name">{a.name}</span>
                                    {a.size !== undefined && <span data-scope={SCOPE} data-part="attachment-size">{formatBytes(a.size)}</span>}
                                    {status === 'uploading' && <span data-scope={SCOPE} data-part="spinner" role="status" aria-label={`Uploading ${a.name}`} />}
                                    {status === 'error' && <ErrorNote data-attachment-error="">{a.error ?? 'Upload failed'}</ErrorNote>}
                                    <Button intent="icon" icon="close" label={`Remove ${a.name}`} onClick={() => emit('removeAttachment', a.id)} />
                                </li>
                            );
                        })}
                    </ul>
                )}
                <div data-scope={SCOPE} data-part="input">
                    <Combobox.Root trigger="@" anchor={caretAnchor} items={mentionItems()} itemKey={mentionKey} itemLabel={mentionLabel} filter={false} model:inputValue={() => st.query}>
                        <Textarea.Root model={() => st.draft} minRows={props.minRows ?? 1} maxRows={props.maxRows ?? 8} disabled={props.disabled} name="message">
                            <Textarea.Label>Message</Textarea.Label>
                            <Textarea.Textarea
                                ref={(h: TextareaHandle | null) => {
                                    box = h;
                                }}
                                placeholder={props.placeholder ?? (busy && props.steers ? 'Steer the running turn…' : 'Message the chat. @ to address an agent, otherwise the coordinator answers.')}
                                onKeydown={onKeydown}
                            />
                        </Textarea.Root>
                    </Combobox.Root>
                </div>
                <div data-scope={SCOPE} data-part="actions">
                    <Button intent="icon" icon="attach" label="Attach file" disabled={props.disabled} onClick={openPicker} />
                    {/* The picker: out of the tab order and the anatomy — the Attach button is its one keyboard path. */}
                    <input
                        ref={(el: HTMLInputElement | null) => {
                            picker = el;
                        }}
                        type="file"
                        multiple
                        accept={props.accept}
                        hidden
                        tabIndex={-1}
                        aria-hidden="true"
                        onChange={(e: Event) => {
                            const el = e.target as HTMLInputElement;
                            take(el.files);
                            // Picking the same file twice in a row still fires `change`.
                            el.value = '';
                        }}
                    />
                    <span data-scope={SCOPE} data-part="keys">
                        <Kbd>Enter</Kbd> to send · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> newline
                    </span>
                    {busy && props.canCancel && (
                        <Button intent="default" icon="stop" onClick={() => emit('cancel')}>
                            Cancel
                        </Button>
                    )}
                    <Button intent="primary" icon="send" type="submit" disabled={!canSend()}>
                        Send
                    </Button>
                </div>
            </form>
        );
    };
}, { name: 'Composer' });
