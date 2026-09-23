/**
 * The Monaco side of the Monaco renderer (#563), loaded on the client only
 * when a code surface first mounts (`./index.tsx` imports this module
 * dynamically), so neither the server nor a page without code pays for it.
 *
 * Monaco itself comes from `@sigx/monaco-editor`'s prebundled assets, which
 * the app serves at the loader's `basePath` (default `/monaco-bundle`).
 */
import { component, onMounted, onUnmounted, signal, type JSXElement } from '@sigx/runtime-core';
import { watch } from '@sigx/reactivity';
import {
    MonacoDiffEditor,
    MonacoEditor,
    configureMonaco,
    isSideBySide,
    languageForPath,
    loadMonaco,
    mountViewZone,
    onLineNumberClick,
    type Disposer,
    type MonacoDiffEditorInstance,
    type MonacoEditorInstance,
    type MonacoNamespace
} from '@sigx/monaco-editor';
import type { CodeDiffProps, CodeViewerProps, LineMark } from '../types.js';
import { MONACO_FONT, MONACO_THEME, monacoTheme } from './theme.js';

configureMonaco({ themes: [monacoTheme()] });

/**
 * The wrapper's components, typed loosely: `@sigx/monaco-editor` types its
 * props against the `sigx` umbrella's JSX, this package against
 * `@sigx/runtime-core`'s — the same runtime, two declarations.
 */
type Forwarding = (props: Record<string, unknown>) => JSXElement;
const Editor = MonacoEditor as unknown as Forwarding;
const DiffEditor = MonacoDiffEditor as unknown as Forwarding;

/** What every surface shares: read-only, no minimap, no current-line highlight, the board's font. */
const baseOptions = {
    ...MONACO_FONT,
    readOnly: true,
    domReadOnly: true,
    minimap: { enabled: false },
    renderLineHighlight: 'none',
    scrollBeyondLastLine: false,
    folding: false,
    glyphMargin: false,
    lineDecorationsWidth: 20,
    lineNumbersMinChars: 4,
    overviewRulerLanes: 0,
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
    contextmenu: false,
    wordWrap: 'off',
    stickyScroll: { enabled: false },
    padding: { top: 10, bottom: 10 },
    automaticLayout: true
} as const;

/** The `onReady` signal back to the wrapper in `./index.tsx`. */
export interface EngineHooks {
    readonly onEngineReady?: () => void;
}

/** Resolve the language once Monaco (and its language registry) is loaded. */
function useLanguage(path: () => string, explicit: () => string | undefined): { readonly value: string | undefined } {
    const st = signal({ monaco: null as MonacoNamespace | null });
    onMounted(() => {
        void loadMonaco().then((m) => { st.monaco = m; }, () => undefined);
    });
    return {
        get value() {
            if (!st.monaco) return undefined;
            return explicit() ?? languageForPath(path(), st.monaco);
        }
    };
}

function markDecorations(marks: readonly LineMark[] | undefined, selected: number | undefined): Array<{ range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }; options: Record<string, unknown> }> {
    const range = (line: number) => ({ startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 });
    const out = (marks ?? []).map((m) => ({ range: range(m.line), options: { linesDecorationsClassName: `ag-code-stripe ag-code-stripe-${m.tone}` } }));
    if (selected !== undefined) out.push({ range: range(selected), options: { isWholeLine: true, className: 'ag-code-selected' } as Record<string, unknown> } as never);
    return out;
}

export const MonacoViewerEngine = component<CodeViewerProps & EngineHooks>(({ props }) => {
    const language = useLanguage(() => props.path, () => props.language);
    let editor: MonacoEditorInstance | null = null;
    let decorations: { set(d: unknown[]): void; clear(): void } | null = null;
    let zone: Disposer | null = null;
    let clicks: Disposer | null = null;

    const apply = (): void => {
        if (!editor) return;
        decorations?.set(markDecorations(props.lineMarks, props.selected));
        zone?.dispose();
        zone = null;
        const render = props.lineWidget;
        if (props.selected !== undefined && render) zone = mountViewZone(editor, { afterLineNumber: props.selected, heightInPx: 160 }, render);
    };
    const reveal = (line: number | undefined): void => {
        if (editor && line !== undefined) editor.revealLineInCenterIfOutsideViewport(line);
    };

    watch(() => [props.lineMarks, props.selected, props.lineWidget] as const, apply);
    watch(() => props.revealLine, reveal);
    onUnmounted(() => {
        zone?.dispose();
        clicks?.dispose();
    });

    const ready = (ed: MonacoEditorInstance): void => {
        editor = ed;
        decorations = ed.createDecorationsCollection() as never;
        clicks = onLineNumberClick(ed, (click) => props.onLineSelect?.(click.line));
        apply();
        reveal(props.revealLine ?? props.selected);
        props.onEngineReady?.();
    };

    return () => language.value === undefined
        ? null
        : (
            <div data-monaco-host="">
                <Editor value={props.text} language={language.value} theme={MONACO_THEME} readOnly lineNumbers="on" minimap={false} fontSize={MONACO_FONT.fontSize} monacoOptions={baseOptions as never} onReady={ready} />
            </div>
        );
}, { name: 'MonacoViewerEngine' });

/** Collapse long unchanged stretches, keeping the handoff's three lines of context around each change. */
const HIDE_UNCHANGED = { enabled: true, contextLineCount: 3, minimumLineCount: 3, revealLineCount: 20 } as const;
/** Module-level so every render passes the same objects: a new one would make the wrapper re-apply options and Monaco recompute the diff. */
const DIFF_OPTIONS = { ...baseOptions, originalEditable: false, renderIndicators: true, renderMarginRevertIcon: false, renderOverviewRuler: false, enableSplitViewResizing: false, useInlineViewWhenSpaceIsLimited: true, diffWordWrap: 'off' } as const;

export const MonacoDiffEngine = component<CodeDiffProps & EngineHooks>(({ props }) => {
    const language = useLanguage(() => props.path, () => props.language);
    let diff: MonacoDiffEditorInstance | null = null;
    let zone: Disposer | null = null;
    let clicks: Disposer | null = null;
    let sideBySide: boolean | null = null;
    let queued = false;
    const listeners: Array<{ dispose(): void }> = [];
    const decorations: Array<{ set(d: unknown[]): void }> = [];

    const apply = (): void => {
        if (!diff) return;
        zone?.dispose();
        zone = null;
        const sel = props.selected;
        const [original, modified] = decorations;
        const mark = (line: number) => [{ range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 }, options: { isWholeLine: true, className: 'ag-code-selected' } }];
        original?.set(sel?.side === 'original' ? mark(sel.line) : []);
        modified?.set(sel?.side === 'modified' ? mark(sel.line) : []);
        const render: (() => JSXElement) | undefined = props.lineWidget;
        // The zone's placement is computed once, so it is remounted whenever the layout or the diff changes.
        if (sel && render) zone = mountViewZone(diff, { afterLineNumber: sel.line, side: sel.side, heightInPx: 160 }, render);
    };
    /** Re-place the widget after Monaco settles — only when there is one, and at most once per task. */
    const reapply = (): void => {
        if (queued || !props.selected || !props.lineWidget) return;
        queued = true;
        setTimeout(() => {
            queued = false;
            apply();
        }, 0);
    };

    watch(() => [props.selected, props.lineWidget] as const, apply);
    // Monaco applies `renderSideBySide` itself; the zone follows once the layout has switched.
    watch(() => props.mode, reapply);
    onUnmounted(() => {
        zone?.dispose();
        clicks?.dispose();
        for (const l of listeners) l.dispose();
    });

    const ready = (d: MonacoDiffEditorInstance): void => {
        diff = d;
        decorations.push(d.getOriginalEditor().createDecorationsCollection() as never, d.getModifiedEditor().createDecorationsCollection() as never);
        clicks = onLineNumberClick(d, (click) => props.onLineSelect?.({ side: click.side, line: click.line }));
        sideBySide = isSideBySide(d);
        listeners.push(
            d.onDidUpdateDiff(reapply),
            // Monaco falls back to unified by itself when the editor gets narrow.
            d.getModifiedEditor().onDidLayoutChange(() => {
                const now = isSideBySide(d);
                if (now !== sideBySide) {
                    sideBySide = now;
                    reapply();
                }
            })
        );
        apply();
        props.onEngineReady?.();
    };

    return () => language.value === undefined
        ? null
        : (
            <div data-monaco-host="">
                <DiffEditor
                    original={props.original}
                    modified={props.modified}
                    language={language.value}
                    theme={MONACO_THEME}
                    readOnly
                    renderSideBySide={props.mode === 'split'}
                    hideUnchangedRegions={HIDE_UNCHANGED}
                    fontSize={MONACO_FONT.fontSize}
                    monacoOptions={DIFF_OPTIONS as never}
                    onReady={ready}
                />
            </div>
        );
}, { name: 'MonacoDiffEngine' });
