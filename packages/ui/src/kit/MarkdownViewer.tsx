/**
 * `MarkdownViewer` — a markdown document as prose (`ag-markdown`, #490): the
 * reading surface whose recipe styles everything `@sigx/richtext/dom`'s
 * `RichTextView` renders inside it (headings on the type scale, list and
 * paragraph rhythm, blockquotes, code blocks with a language and copy
 * header, tables, task boxes, links, images). `@sigx/richtext` ships no
 * stylesheet on purpose; this is ours.
 *
 * Fenced code highlights through shiki (`@sigx/richtext-shiki`), loaded on
 * the first block and never failing louder than plain text. One highlighter
 * per app (`markdownHighlighter`); pass `highlighter={false}` to stay plain
 * — tests do, so vitest never imports shiki. `compact` is the size a card's
 * well shows a document at; the plan card uses it.
 */
import { component, onMounted, type Define } from '@sigx/runtime-core';
import type { Code } from '@sigx/richtext';
import { markdownFormat } from '@sigx/richtext-markdown';
import { CodeBlock, RichTextView, highlightedCodeBlock, type CodeHighlighter, type DomComponents, type DomLinkHandler } from '@sigx/richtext/dom';
import { createShikiHighlighter } from '@sigx/richtext-shiki';
import { agMarkdownAnatomy } from './anatomy.js';

const SCOPE = agMarkdownAnatomy.scope;

let shared: CodeHighlighter | undefined;

/** The app's one shiki highlighter: made on first use, so a page without code never loads the engine. */
export function markdownHighlighter(): CodeHighlighter {
    return (shared ??= createShikiHighlighter());
}

type HighlightedCodeProps =
    & Define.Prop<'value', string, true>
    & Define.Prop<'lang', string | null, true>
    & Define.Prop<'meta', string | null, true>
    & Define.Prop<'open', boolean, true>
    & Define.Prop<'node', Code, true>
    & Define.Prop<'highlighter', CodeHighlighter, true>;

/**
 * A fenced block that highlights once it stands on the client's own DOM.
 * The server renders the block plain (no engine there), and a hydrated
 * `<code>` whose text child is later patched to token lines gets the lines
 * twice (signalxjs/core#733). So the
 * plain `CodeBlock` — the markup the server sent — renders until mount, and
 * the highlighted block, another component, takes its place with fresh nodes.
 */
const HighlightedCode = component<HighlightedCodeProps>(({ props, signal }) => {
    const st = signal({ mounted: false });
    onMounted(() => { st.mounted = true; });
    const highlighted = highlightedCodeBlock(props.highlighter);
    return () => st.mounted
        ? highlighted({ value: props.value, lang: props.lang, meta: props.meta, open: props.open, node: props.node })
        : <CodeBlock value={props.value} lang={props.lang} meta={props.meta} open={props.open} />;
}, { name: 'HighlightedCode' });

/** The `code` slot for `RichTextView`'s `components`: highlighted through `highlighter`, hydration-safe. */
function highlightedCode(highlighter: CodeHighlighter): DomComponents['code'] {
    return (p) => <HighlightedCode value={p.value} lang={p.lang} meta={p.meta} open={p.open} node={p.node} highlighter={highlighter} />;
}

export type MarkdownViewerProps =
    & Define.Prop<'value', string, true>
    /** The card-well size: 13 px type, half the block rhythm. */
    & Define.Prop<'compact', boolean, false>
    /** Link clicks go here instead of navigating (a router, a chat file opener). */
    & Define.Prop<'onLink', DomLinkHandler, false>
    /** `target` for links when no `onLink`. Default `_blank`. */
    & Define.Prop<'linkTarget', '_blank' | '_self', false>
    /** Another highlighter, or `false` for plain code. Default: the shared shiki one. */
    & Define.Prop<'highlighter', CodeHighlighter | false, false>;

export const MarkdownViewer = component<MarkdownViewerProps>(({ props }) => {
    // Build the component map once per instance, not per render.
    const highlighter = props.highlighter === false ? undefined : (props.highlighter ?? markdownHighlighter());
    const components: Partial<DomComponents> | undefined = highlighter ? { code: highlightedCode(highlighter) } : undefined;
    return () => (
        <div data-scope={SCOPE} data-part="root" data-mod-compact={props.compact ? '' : undefined}>
            <RichTextView value={props.value} format={markdownFormat} linkTarget={props.linkTarget ?? '_blank'} onLink={props.onLink} components={components} />
        </div>
    );
}, { name: 'MarkdownViewer' });
