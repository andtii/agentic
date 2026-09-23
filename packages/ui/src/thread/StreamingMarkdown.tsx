/**
 * `StreamingMarkdown` — a growing text part as markdown, on
 * `@sigx/richtext/dom`'s `RichTextView` with `@sigx/richtext-markdown`'s
 * `markdownFormat` (a module constant — a new format identity would re-create
 * the engine).
 *
 * The view owns one incremental engine: as `text` grows, only the live tail
 * re-parses and only the block still being written re-renders — finalized
 * blocks keep their identity. `text` is read inside THIS component's render,
 * so a `part-delta` (`part.text += delta` in the reducer) re-runs this
 * component alone: one signal, one part, one render.
 */
import { component, type Define } from '@sigx/runtime-core';
import { RichTextView } from '@sigx/richtext/dom';
import { markdownFormat } from '@sigx/richtext-markdown';

export type StreamingMarkdownProps =
    & Define.Prop<'text', string, true>
    /** The part has ended (`part-end`). Rendering is the same; the flag is for the consumer's chrome. */
    & Define.Prop<'done', boolean, false>;

export const StreamingMarkdown = component<StreamingMarkdownProps>(({ props }) => {
    return () => <RichTextView value={props.text} format={markdownFormat} linkTarget="_blank" />;
}, { name: 'StreamingMarkdown' });
