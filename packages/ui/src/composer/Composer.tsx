/**
 * `Composer` — the prompt box (`ai-composer`, `docs/design/HANDOFF.md` →
 * `ai-composer`): the addressing row ("To" + recipient chips + hint), zero's
 * `Textarea` that grows with its lines, an `@mention` popup, the
 * attachments strip, and the action row — attach, the key hint, Cancel
 * while a turn can be cancelled, `Send` primary.
 *
 * Enter sends, Shift+Enter breaks a line. While a turn runs Send stays
 * enabled only when the agent can be steered (`steers`), and Cancel appears
 * only when it can be cancelled (`canCancel`) — capabilities, never who the
 * agent is. Who the message goes to is the page's resolution (mentions ∩
 * members, else the coordinator, else the single member, else nobody) —
 * this component only shows it.
 *
 * Files come in three ways — the Attach button's hidden
 * `<input type=file multiple>`, a paste carrying `clipboardData.files`, and
 * a drag-and-drop onto the card — and all three emit one `files` event with
 * a `File[]`. The composer never uploads: the host turns files into
 * `attachments` (with a `status`) and the strip renders them — a thumbnail
 * when there is a `previewUrl`, a spinner while `uploading`, the error line
 * on `error`, and a remove button. Send waits while any chip is uploading
 * and goes with an empty draft when there are attachments. While a drag
 * carrying files hovers, the root carries zero's governed `highlighted`
 * flag — zero's own `FileUpload` spells drag-over the same way, and the
 * flag vocabulary is closed (no `data-dragging`).
 *
 * Keys are read on the FORM: zero's `Textarea.Textarea` declares no key or
 * input handlers of its own (andtii/zero-wip#481), and the events
 * bubble to the root either way — one listener, filtered on the target.
 * The same gap means the textarea takes no ARIA props, so its combobox
 * attributes (`aria-controls` / `aria-expanded` / `aria-activedescendant`)
 * are synced onto the element after every render.
 */
import { component, onMounted, onUpdated, type Define } from '@sigx/runtime-core';
import { Textarea, dataAttr } from '@sigx/zero';
import { AgentTile, type AgentHue } from '../kit/AgentTile.js';
import { Button } from '../kit/Button.js';
import { Icon } from '../kit/icons.js';
import { formatBytes } from '../thread/text.js';
import { aiComposerAnatomy } from './anatomy.js';
import { filterMentions, insertMention, mentionAt, rowsFor, type Mention, type MentionQuery } from './mentions.js';

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
    /** Autogrow bounds in rows. Default 1–8. */
    & Define.Prop<'minRows', number, false>
    & Define.Prop<'maxRows', number, false>;

let seq = 0;

export const Composer = component<ComposerProps>(({ props, emit, signal }) => {
    const st = signal({ draft: '', caret: 0, highlighted: 0, dismissed: false, dragging: false });
    const listId = `ai-composer-mentions-${++seq}`;
    let form: HTMLFormElement | null = null;
    let picker: HTMLInputElement | null = null;
    /** `dragenter` / `dragleave` fire per child crossed — a depth count says when the drag really left. */
    let dragDepth = 0;

    const textarea = (): HTMLTextAreaElement | null => form?.querySelector('textarea') ?? null;

    /** A stable option id per mention, so the active descendant survives refiltering. */
    const optionId = (m: Mention): string => `${listId}-${m.id.replace(/[^A-Za-z0-9_-]/g, '_')}`;

    const syncAria = (): void => {
        const el = textarea();
        if (!el) return;
        el.setAttribute('role', 'combobox');
        el.setAttribute('aria-autocomplete', 'list');
        el.setAttribute('aria-controls', listId);
        const isOpen = open();
        el.setAttribute('aria-expanded', String(isOpen));
        const active = isOpen ? matches()[st.highlighted] : undefined;
        if (active) el.setAttribute('aria-activedescendant', optionId(active));
        else el.removeAttribute('aria-activedescendant');
    };
    onMounted(syncAria);
    onUpdated(syncAria);

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

    /** The token under the caret and the entries matching it — the popup's whole state. */
    const query = (): MentionQuery | undefined => (props.mentions?.length ? mentionAt(st.draft, st.caret) : undefined);
    const matches = (): Mention[] => {
        const q = query();
        return q ? filterMentions(props.mentions ?? [], q.query) : [];
    };
    const open = (): boolean => !st.dismissed && matches().length > 0;

    const send = (): void => {
        const text = st.draft.trim();
        if ((!text && !hasAttachments()) || !canSend()) return;
        st.draft = '';
        st.caret = 0;
        emit('send', text);
        // The composer keeps focus after send.
        textarea()?.focus();
    };

    const pick = (m: Mention): void => {
        const q = query();
        if (!q) return;
        const next = insertMention(st.draft, q, m);
        st.draft = next.text;
        st.caret = next.caret;
        st.highlighted = 0;
        const el = textarea();
        if (el) queueMicrotask(() => el.setSelectionRange(next.caret, next.caret));
    };

    const onInput = (e: Event): void => {
        const el = e.target as HTMLTextAreaElement | null;
        if (!el || el.tagName !== 'TEXTAREA') return;
        st.draft = el.value;
        st.caret = el.selectionStart ?? el.value.length;
        st.dismissed = false;
        st.highlighted = 0;
    };

    const onKeydown = (e: KeyboardEvent): void => {
        if ((e.target as HTMLElement | null)?.tagName !== 'TEXTAREA') return;
        if (open()) {
            const list = matches();
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                st.highlighted = (st.highlighted + 1) % list.length;
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                st.highlighted = (st.highlighted - 1 + list.length) % list.length;
                return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                pick(list[st.highlighted] ?? list[0]!);
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                st.dismissed = true;
                return;
            }
        }
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            send();
        }
    };

    return () => {
        const list = matches();
        const isOpen = open();
        const busy = props.busy === true;
        const recipients = props.recipients;
        const hint = recipients ? (props.hint ?? (recipients.length === 0 ? NOBODY_HINT : undefined)) : undefined;
        return (
            <form
                data-scope={SCOPE}
                data-part="root"
                data-highlighted={dataAttr(st.dragging)}
                ref={(el: HTMLFormElement | null) => {
                    form = el;
                }}
                onSubmit={(e: Event) => {
                    e.preventDefault();
                    send();
                }}
                onInput={onInput}
                onKeydown={onKeydown}
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
                                    {status === 'error' && (
                                        <span data-scope={SCOPE} data-part="attachment-error" role="alert">
                                            {a.error ?? 'Upload failed'}
                                        </span>
                                    )}
                                    <Button intent="icon" icon="close" label={`Remove ${a.name}`} onClick={() => emit('removeAttachment', a.id)} />
                                </li>
                            );
                        })}
                    </ul>
                )}
                <div data-scope={SCOPE} data-part="input">
                    <Textarea.Root model={() => st.draft} rows={rowsFor(st.draft, props.minRows ?? 1, props.maxRows ?? 8)} disabled={props.disabled} name="message">
                        <Textarea.Label>Message</Textarea.Label>
                        <Textarea.Textarea placeholder={props.placeholder ?? (busy && props.steers ? 'Steer the running turn…' : 'Message the chat. @ to address an agent, otherwise the coordinator answers.')} />
                    </Textarea.Root>
                    <ul id={listId} role="listbox" aria-label="Mentions" data-scope={SCOPE} data-part="mentions" data-state={isOpen ? 'open' : 'closed'} hidden={!isOpen}>
                        {list.map((m, i) => (
                            <li
                                key={m.id}
                                id={optionId(m)}
                                role="option"
                                aria-selected={i === st.highlighted}
                                data-scope={SCOPE}
                                data-part="mention"
                                data-highlighted={dataAttr(i === st.highlighted)}
                                onMousedown={(e: Event) => e.preventDefault()}
                                onClick={() => pick(m)}
                            >
                                {m.label}
                            </li>
                        ))}
                    </ul>
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
                    <span data-scope={SCOPE} data-part="keys">Enter to send · Shift+Enter newline</span>
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
