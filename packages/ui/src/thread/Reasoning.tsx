/**
 * `Reasoning` — a reasoning part on zero's `Collapsible` (a native
 * `<details>`) inside the `ai-reasoning` root, collapsed by default as
 * "Reasoning · 6s" behind the chevron in `text-dim`
 * (`docs/design/HANDOFF.md` → `ai-reasoning`).
 *
 * Four cases, two of them with text. A harness may open a REAL reasoning
 * part and redact its text (Claude Code streams empty deltas and reports
 * progress as `usage.reasoningTokens`), so empty text alone cannot tell
 * "still thinking" from "thought and showed nothing": while the part is open
 * the summary says so, with the token count once one arrives; once it has
 * ended with nothing to show there is nothing to say and nothing renders.
 * Exposed reasoning is long: open while it streams, folded once done — and
 * the reader's own toggle wins over that default from then on (the
 * Collapsible's `model` + `onOpenChange`, `./disclosure`).
 */
import { component, type Define } from '@sigx/runtime-core';
import type { ReasoningPartState } from '@sigx/ai-agent/app';
import { Collapsible } from '@sigx/zero';
import { aiReasoningAnatomy } from './anatomy.js';
import { followDisclosure } from './disclosure.js';
import { nonBlank } from './text.js';
import { StreamingMarkdown } from './StreamingMarkdown.js';

const SCOPE = aiReasoningAnatomy.scope;

export type ReasoningProps =
    & Define.Prop<'part', ReasoningPartState, true>
    /** `usage.reasoningTokens` — the only progress a harness that hides its thinking gives us. */
    & Define.Prop<'reasoningTokens', number, false>
    /** How long the block took, once known — `Reasoning · 6s`. */
    & Define.Prop<'seconds', number, false>;

/** The summary line: `Thinking… 120 tokens` while open, `Reasoning · 6s` once done. */
export function reasoningSummary(part: ReasoningPartState, tokens?: number, seconds?: number): string {
    if (!part.done) return `Thinking…${tokens ? ` ${tokens} tokens` : ''}`;
    return seconds !== undefined ? `Reasoning · ${Math.round(seconds)}s` : 'Reasoning';
}

export const Reasoning = component<ReasoningProps>(({ props }) => {
    const disclosure = followDisclosure(() => props.part.done !== true);

    return () => {
        const part = props.part;
        const thought = nonBlank(part.text);
        if (!thought && part.done) return null;
        return (
            <div data-scope={SCOPE} data-part="root">
                <Collapsible.Root
                    model={() => disclosure.open}
                    onOpenChange={() => {
                        disclosure.touched = true;
                    }}
                >
                    <Collapsible.Trigger>
                        <span data-scope={SCOPE} data-part="summary">
                            {reasoningSummary(part, props.reasoningTokens, props.seconds)}
                        </span>
                    </Collapsible.Trigger>
                    {thought && (
                        <Collapsible.Panel>
                            <div data-scope={SCOPE} data-part="body">
                                <StreamingMarkdown text={thought} done={part.done === true} />
                            </div>
                        </Collapsible.Panel>
                    )}
                </Collapsible.Root>
            </div>
        );
    };
}, { name: 'Reasoning' });
