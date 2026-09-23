/**
 * The plain code renderer (#563): the numbered grid the `Changes` and
 * `Files` boards draw, as server-rendered markup — no engine, no
 * highlighting. It is what SSR sends, what a browser without JavaScript
 * keeps, what happy-dom tests render, and what the Monaco renderer shows
 * until Monaco has loaded. Line numbers are buttons when a caller listens.
 */
import { component, onMounted, type JSXElement } from '@sigx/runtime-core';
import { watch } from '@sigx/reactivity';
import { agCodeAnatomy } from './anatomy.js';
import { diffLines, splitLines, splitRows, unifiedRows, type DiffRow, type LineRef, type SplitRow } from './line-diff.js';
import type { CodeDiffProps, CodeRenderer, CodeViewerProps } from './types.js';

const SCOPE = agCodeAnatomy.scope;

/** A line number: a button when the caller listens for line selection, else inert text. */
function lineNumber(line: number | undefined, label: string, select: (() => void) | undefined): JSXElement {
    if (line === undefined) return <span data-scope={SCOPE} data-part="num" aria-hidden="true" />;
    return select
        ? <button type="button" data-scope={SCOPE} data-part="num" aria-label={label} onClick={select}>{line}</button>
        : <span data-scope={SCOPE} data-part="num" aria-hidden="true">{line}</span>;
}

/** Text of a line; an empty line keeps its height. */
const lineText = (text: string, tone?: string): JSXElement => <span data-scope={SCOPE} data-part="text" data-tone={tone}>{text === '' ? ' ' : text}</span>;

function widget(render: (() => JSXElement) | undefined): JSXElement | null {
    return render ? <div data-scope={SCOPE} data-part="widget">{render()}</div> : null;
}

/** Scroll a row into view inside its surface, once it is in the DOM. */
function reveal(root: HTMLElement | null, line: number | undefined): void {
    if (!root || line === undefined) return;
    const row = root.querySelector<HTMLElement>(`[data-line="${line}"]`);
    row?.scrollIntoView?.({ block: 'center' });
}

export const PlainViewer = component<CodeViewerProps>(({ props }) => {
    let root: HTMLElement | null = null;
    onMounted(() => reveal(root, props.revealLine ?? props.selected));
    watch(() => props.revealLine, (line) => reveal(root, line));
    return () => {
        const marks = new Map((props.lineMarks ?? []).map((m) => [m.line, m.tone]));
        const select = props.onLineSelect;
        return (
            <div data-scope={SCOPE} data-part="root" data-kind="viewer" data-engine="plain" role="region" aria-label={props.path} tabIndex={0} ref={(el: HTMLElement) => { root = el; }}>
                {splitLines(props.text).flatMap((text, i) => {
                    const line = i + 1;
                    const selected = props.selected === line;
                    return [
                        <div data-scope={SCOPE} data-part="row" data-line={line} data-selected={selected ? '' : undefined}>
                            {lineNumber(line, `Line ${line}`, select ? () => select(line) : undefined)}
                            <span data-scope={SCOPE} data-part="stripe" data-tone={marks.get(line)} />
                            {lineText(text)}
                        </div>,
                        selected ? widget(props.lineWidget) : null
                    ];
                })}
            </div>
        );
    };
}, { name: 'PlainViewer' });

/** Does a unified row carry the selected line? */
function unifiedCarries(row: DiffRow, ref: LineRef | undefined): boolean {
    if (!ref || row.kind === 'hunk') return false;
    return ref.side === 'original' ? row.kind !== 'added' && row.old === ref.line : row.kind !== 'removed' && row.new === ref.line;
}

function splitCarries(row: SplitRow, ref: LineRef | undefined): boolean {
    if (!ref || row.kind === 'hunk') return false;
    return ref.side === 'original' ? row.left?.line === ref.line : row.right?.line === ref.line;
}

export const PlainDiff = component<CodeDiffProps>(({ props }) => () => {
    const ops = diffLines(props.original, props.modified);
    const select = props.onLineSelect;
    const pick = (side: LineRef['side'], line: number | undefined): (() => void) | undefined => (select && line !== undefined ? () => select({ side, line }) : undefined);
    const hunk = (text: string, split: boolean): JSXElement => (
        <div data-scope={SCOPE} data-part="row" data-hunk="">
            <span data-scope={SCOPE} data-part="num" aria-hidden="true" />
            {split ? null : <span data-scope={SCOPE} data-part="num" aria-hidden="true" />}
            <span data-scope={SCOPE} data-part="marker" aria-hidden="true" />
            {lineText(text)}
        </div>
    );
    if (!ops.some((op) => op.kind !== 'equal')) {
        return <div data-scope={SCOPE} data-part="root" data-kind="diff" data-engine="plain" data-mode={props.mode}><p data-scope={SCOPE} data-part="notice">No differences.</p></div>;
    }
    if (props.mode === 'split') {
        return (
            <div data-scope={SCOPE} data-part="root" data-kind="diff" data-engine="plain" data-mode="split" role="region" aria-label={`Changes to ${props.path}`} tabIndex={0}>
                {splitRows(ops).flatMap((row) => {
                    if (row.kind === 'hunk') return [hunk(row.text, true)];
                    const l = row.left;
                    const r = row.right;
                    const lTone = l?.change ? 'failed' : undefined;
                    const rTone = r?.change ? 'live' : undefined;
                    const selected = splitCarries(row, props.selected);
                    return [
                        <div data-scope={SCOPE} data-part="row" data-line={r?.line ?? l?.line} data-context={!l?.change && !r?.change ? '' : undefined} data-selected={selected ? '' : undefined}>
                            {lineNumber(l?.line, `Line ${l?.line} before`, pick('original', l?.line))}
                            <span data-scope={SCOPE} data-part="marker" data-tone={lTone} aria-hidden="true">{l?.change ? '-' : ''}</span>
                            {l ? lineText(l.text, lTone) : <span data-scope={SCOPE} data-part="text" data-empty="" />}
                            {lineNumber(r?.line, `Line ${r?.line} after`, pick('modified', r?.line))}
                            <span data-scope={SCOPE} data-part="marker" data-tone={rTone} aria-hidden="true">{r?.change ? '+' : ''}</span>
                            {r ? lineText(r.text, rTone) : <span data-scope={SCOPE} data-part="text" data-empty="" />}
                        </div>,
                        selected ? widget(props.lineWidget) : null
                    ];
                })}
            </div>
        );
    }
    return (
        <div data-scope={SCOPE} data-part="root" data-kind="diff" data-engine="plain" data-mode="unified" role="region" aria-label={`Changes to ${props.path}`} tabIndex={0}>
            {unifiedRows(ops).flatMap((row) => {
                if (row.kind === 'hunk') return [hunk(row.text, false)];
                const old = row.kind === 'added' ? undefined : row.old;
                const now = row.kind === 'removed' ? undefined : row.new;
                const tone = row.kind === 'added' ? 'live' : row.kind === 'removed' ? 'failed' : undefined;
                const selected = unifiedCarries(row, props.selected);
                return [
                    <div data-scope={SCOPE} data-part="row" data-line={now ?? old} data-tone={tone} data-context={row.kind === 'context' ? '' : undefined} data-selected={selected ? '' : undefined}>
                        {lineNumber(old, `Line ${old} before`, pick('original', old))}
                        {lineNumber(now, `Line ${now} after`, pick('modified', now))}
                        <span data-scope={SCOPE} data-part="marker" aria-hidden="true">{row.kind === 'added' ? '+' : row.kind === 'removed' ? '-' : ''}</span>
                        {lineText(row.text)}
                    </div>,
                    selected ? widget(props.lineWidget) : null
                ];
            })}
        </div>
    );
}, { name: 'PlainDiff' });

/** The plain renderer as a `CodeRenderer`. */
export const plainCodeRenderer: CodeRenderer = { id: 'plain', Viewer: PlainViewer, Diff: PlainDiff };
