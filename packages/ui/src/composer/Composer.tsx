/**
 * `Composer` — the prompt box (`ai-composer`): zero's `Textarea` that grows
 * with its lines, an `@mention` popup, an attachments strip (a stub: the
 * list is the consumer's, the picker is a follow-up), and the Send / Cancel
 * buttons as zero `Button`s.
 *
 * Enter sends, Shift+Enter breaks a line. While a turn runs Send stays
 * enabled only when the agent can be steered (`steers`), and Cancel appears
 * only when it can be cancelled (`canCancel`) — capabilities, never who the
 * agent is.
 *
 * Keys are read on the FORM: zero's `Textarea.Textarea` declares no key or
 * input handlers of its own (andtii/zero-wip#481), and the events
 * bubble to the root either way — one listener, filtered on the target.
 */
import { component, type Define } from '@sigx/runtime-core';
import { Button, Kbd, Textarea, dataAttr } from '@sigx/zero';
import { aiComposerAnatomy } from './anatomy.js';
import { filterMentions, insertMention, mentionAt, rowsFor, type Mention, type MentionQuery } from './mentions.js';

const SCOPE = aiComposerAnatomy.scope;

export interface Attachment {
    readonly id: string;
    readonly name: string;
    readonly size?: number;
}

export type ComposerProps =
    /** The text to send — trimmed, never empty. */
    & Define.Event<'send', string>
    /** Cancel the running turn. */
    & Define.Event<'cancel'>
    /** Remove one attachment by id. */
    & Define.Event<'removeAttachment', string>
    /** A turn is running or awaiting. */
    & Define.Prop<'busy', boolean, false>
    /** `capabilities.steer` — a prompt during a turn lands inside it. */
    & Define.Prop<'steers', boolean, false>
    /** `capabilities.cancel`. */
    & Define.Prop<'canCancel', boolean, false>
    & Define.Prop<'disabled', boolean, false>
    & Define.Prop<'placeholder', string, false>
    /** Who can be mentioned with `@`. */
    & Define.Prop<'mentions', readonly Mention[], false>
    & Define.Prop<'attachments', readonly Attachment[], false>
    /** Autogrow bounds in rows. Default 1–8. */
    & Define.Prop<'minRows', number, false>
    & Define.Prop<'maxRows', number, false>;

let seq = 0;

export const Composer = component<ComposerProps>(({ props, emit, signal }) => {
    const st = signal({ draft: '', caret: 0, highlighted: 0, dismissed: false });
    const listId = `ai-composer-mentions-${++seq}`;
    let form: HTMLFormElement | null = null;

    const textarea = (): HTMLTextAreaElement | null => form?.querySelector('textarea') ?? null;

    const canSend = (): boolean => !props.disabled && (!props.busy || props.steers === true);

    /** The token under the caret and the entries matching it — the popup's whole state. */
    const query = (): MentionQuery | undefined => (props.mentions?.length ? mentionAt(st.draft, st.caret) : undefined);
    const matches = (): Mention[] => {
        const q = query();
        return q ? filterMentions(props.mentions ?? [], q.query) : [];
    };
    const open = (): boolean => !st.dismissed && matches().length > 0;

    const send = (): void => {
        const text = st.draft.trim();
        if (!text || !canSend()) return;
        st.draft = '';
        st.caret = 0;
        emit('send', text);
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
        return (
            <form
                data-scope={SCOPE}
                data-part="root"
                ref={(el: HTMLFormElement | null) => {
                    form = el;
                }}
                onSubmit={(e: Event) => {
                    e.preventDefault();
                    send();
                }}
                onInput={onInput}
                onKeydown={onKeydown}
            >
                {props.attachments && props.attachments.length > 0 && (
                    <ul data-scope={SCOPE} data-part="attachments">
                        {props.attachments.map((a) => (
                            <li key={a.id} data-scope={SCOPE} data-part="attachment">
                                <span>{a.name}</span>
                                <Button.Root type="button" size="xs" onClick={() => emit('removeAttachment', a.id)}>
                                    Remove
                                </Button.Root>
                            </li>
                        ))}
                    </ul>
                )}
                <div data-scope={SCOPE} data-part="input">
                    <Textarea.Root model={() => st.draft} rows={rowsFor(st.draft, props.minRows ?? 1, props.maxRows ?? 8)} disabled={props.disabled} name="message">
                        <Textarea.Label>Message</Textarea.Label>
                        <Textarea.Textarea placeholder={props.placeholder ?? (busy && props.steers ? 'Steer the running turn…' : 'Message…')} />
                    </Textarea.Root>
                    <ul id={listId} role="listbox" aria-label="Mentions" data-scope={SCOPE} data-part="mentions" data-state={isOpen ? 'open' : 'closed'} hidden={!isOpen}>
                        {list.map((m, i) => (
                            <li
                                key={m.id}
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
                    <small>
                        <Kbd.Root size="sm">Enter</Kbd.Root> to send
                    </small>
                    {busy && props.canCancel && (
                        <Button.Root type="button" onClick={() => emit('cancel')}>
                            Cancel
                        </Button.Root>
                    )}
                    <Button.Root type="submit" color="primary" disabled={!canSend()}>
                        Send
                    </Button.Root>
                </div>
            </form>
        );
    };
}, { name: 'Composer' });
