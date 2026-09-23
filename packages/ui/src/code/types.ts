/**
 * The code surface seam (#563): what a renderer draws for the Files viewer
 * and the Changes diff. Pages render `CodeViewer` / `CodeDiff` and never
 * name an engine; the app (or a subtree, or a test) chooses the renderer
 * with `useCodeRenderer` — Monaco by default, the plain grid for SSR, no-JS
 * and happy-dom, or anything else that takes these props.
 */
import type { ComponentFactory, JSXElement } from '@sigx/runtime-core';
import type { DiffSide, LineRef } from './line-diff.js';

/** How a marked line is painted: the 3 px stripe beside the number (`working` = differs from HEAD). */
export type LineMarkTone = 'working' | 'live' | 'failed' | 'needs-you';

export interface LineMark {
    /** 1-based. */
    readonly line: number;
    readonly tone: LineMarkTone;
}

/** What a viewer is given: one read-only text. */
export interface CodeViewerProps {
    readonly text: string;
    /** The file's path, for the language and the accessible name. */
    readonly path: string;
    /** A language id, when the caller knows better than the path. */
    readonly language?: string;
    readonly lineMarks?: readonly LineMark[];
    /** The line whose number was chosen; it carries the `needs-you` inset and the widget below it. */
    readonly selected?: number;
    /** Line numbers become buttons when this is set. */
    readonly onLineSelect?: (line: number) => void;
    /** Rendered under `selected` (an inline composer). */
    readonly lineWidget?: () => JSXElement;
    /** Scroll `selected` (or this line) into view once rendered. */
    readonly revealLine?: number;
}

export type DiffMode = 'unified' | 'split';

/** What a diff is given: both texts — the renderer computes the hunks. */
export interface CodeDiffProps {
    readonly original: string;
    readonly modified: string;
    readonly path: string;
    readonly language?: string;
    readonly mode: DiffMode;
    readonly selected?: LineRef;
    readonly onLineSelect?: (ref: LineRef) => void;
    readonly lineWidget?: () => JSXElement;
}

/** A pluggable code renderer: a viewer and a diff with the props above. */
export interface CodeRenderer {
    /** A short id for diagnostics and tests (`plain`, `monaco`). */
    readonly id: string;
    readonly Viewer: ComponentFactory<CodeViewerProps, void, {}>;
    readonly Diff: ComponentFactory<CodeDiffProps, void, {}>;
}

export type { DiffSide, LineRef };
