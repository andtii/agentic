/**
 * "Ask <agent> about line n" (#563): the inline composer a diff or viewer
 * renders under the selected line. It only collects the question; where it
 * goes (the session's chat, with the hunk attached) is the caller's. Enter
 * inserts a newline, Ctrl/Cmd+Enter sends, Escape cancels — the keys of
 * zero's `Textarea`, which autosizes from two rows.
 */
import { component, onMounted, signal, type Define } from '@sigx/runtime-core';
import { Textarea, type TextareaHandle } from '@sigx/zero';
import { AgentTile, type AgentHue } from '../kit/AgentTile.js';
import { Button } from '../kit/Button.js';
import { agLineComposerAnatomy } from './anatomy.js';

const SCOPE = agLineComposerAnatomy.scope;

export type LineComposerProps =
    & Define.Prop<'agent', { readonly name: string; readonly hue?: AgentHue }, true>
    & Define.Prop<'line', number, true>
    /** `shell.css:61`. */
    & Define.Prop<'fileRef', string, true>
    /** Where it posts ("Posts to "Mobile pass #47" with the file, line and hunk attached"). */
    & Define.Prop<'note', string>
    & Define.Prop<'sending', boolean>
    & Define.Prop<'sendLabel', string>
    & Define.Prop<'onSend', (text: string) => void, true>
    & Define.Prop<'onCancel', () => void, true>;

export const LineComposer = component<LineComposerProps>(({ props }) => {
    const st = signal({ text: '' });
    let input: TextareaHandle | null = null;
    onMounted(() => input?.focus());
    const send = (): void => {
        const text = st.text.trim();
        if (text && !props.sending) props.onSend(text);
    };
    return () => (
        <form
            data-scope={SCOPE}
            data-part="root"
            aria-label={`Ask ${props.agent.name} about line ${props.line}`}
            onSubmit={(e: Event) => {
                e.preventDefault();
                send();
            }}
        >
            <div data-scope={SCOPE} data-part="head">
                <AgentTile name={props.agent.name} hue={props.agent.hue} size={20} />
                <span data-scope={SCOPE} data-part="title">Ask {props.agent.name} about line {props.line}</span>
                <span data-scope={SCOPE} data-part="ref">{props.fileRef}</span>
            </div>
            <div data-scope={SCOPE} data-part="input">
                <Textarea.Root model={() => st.text} minRows={2}>
                    <Textarea.Label visuallyHidden>Question about this line</Textarea.Label>
                    <Textarea.Textarea
                        ref={(h: TextareaHandle | null) => { input = h; }}
                        onKeydown={(e: KeyboardEvent) => {
                            if (e.key === 'Escape') {
                                e.preventDefault();
                                props.onCancel();
                            } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                                e.preventDefault();
                                send();
                            }
                        }}
                    />
                </Textarea.Root>
            </div>
            <div data-scope={SCOPE} data-part="foot">
                {props.note ? <span data-scope={SCOPE} data-part="note">{props.note}</span> : null}
                <Button onClick={() => props.onCancel()}>Cancel</Button>
                <Button intent="primary" type="submit" icon="send" loading={props.sending} disabled={!st.text.trim()}>{props.sendLabel ?? 'Send to chat'}</Button>
            </div>
        </form>
    );
}, { name: 'LineComposer' });
