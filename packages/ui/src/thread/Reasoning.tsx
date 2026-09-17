/**
 * `Reasoning` — a reasoning part on a native `<details>` (`ai-reasoning`).
 *
 * Four cases, two of them with text. A harness may open a REAL reasoning
 * part and redact its text (Claude Code streams empty deltas and reports
 * progress as `usage.reasoningTokens`), so empty text alone cannot tell
 * "still thinking" from "thought and showed nothing": while the part is open
 * the summary says so, with the token count once one arrives; once it has
 * ended with nothing to show there is nothing to say and nothing renders.
 * Exposed reasoning is long: open while it streams, folded once done — and
 * the reader's own toggle wins over that default from then on.
 */
import { component, type Define } from '@sigx/runtime-core';
import type { ReasoningPartState } from '@sigx/ai-agent/app';
import { aiReasoningAnatomy } from './anatomy.js';
import { nonBlank } from './text.js';
import { StreamingMarkdown } from './StreamingMarkdown.js';

const SCOPE = aiReasoningAnatomy.scope;

export type ReasoningProps =
    & Define.Prop<'part', ReasoningPartState, true>
    /** `usage.reasoningTokens` — the only progress a harness that hides its thinking gives us. */
    & Define.Prop<'reasoningTokens', number, false>;

export const Reasoning = component<ReasoningProps>(({ props, signal }) => {
    /** The reader's toggle, once used; `undefined` means "follow the part". */
    const st = signal({ open: undefined as boolean | undefined });

    return () => {
        const part = props.part;
        const thought = nonBlank(part.text);
        if (!thought && part.done) return null;
        const open = st.open ?? !part.done;
        const n = props.reasoningTokens;
        const summary = part.done ? 'Thought' : `Thinking…${n ? ` ${n} tokens` : ''}`;
        return (
            <details
                data-scope={SCOPE}
                data-part="root"
                data-state={open ? 'open' : 'closed'}
                open={open}
                onToggle={(e: Event) => {
                    st.open = (e.currentTarget as HTMLDetailsElement).open;
                }}
            >
                <summary data-scope={SCOPE} data-part="summary">{summary}</summary>
                {thought && (
                    <div data-scope={SCOPE} data-part="body">
                        <StreamingMarkdown text={thought} done={part.done === true} />
                    </div>
                )}
            </details>
        );
    };
}, { name: 'Reasoning' });
