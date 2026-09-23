/**
 * The Monaco theme, generated from the design system's tokens (#563) — the
 * same `palette` the `control-room` daisyUI theme is built from, so a token
 * change reaches the editor with no hex written here. Monaco wants
 * `#rrggbb[aa]` colours, so the 8 % diff tints are the ink with an alpha
 * byte, the same mix the plain grid paints with `color-mix`; like the board,
 * changes are tinted per line only, with no word-level highlight.
 */
import type { ThemePack } from '@sigx/monaco-editor';
import { palette, system } from '../../design-system/tokens.js';

/** The Monaco theme id. */
export const MONACO_THEME = 'control-room';

/** `#rrggbb` at `alpha` (0–1) as `#rrggbbaa`. */
export function withAlpha(hex: string, alpha: number): string {
    const byte = Math.round(Math.min(1, Math.max(0, alpha)) * 255).toString(16).padStart(2, '0');
    return `${hex.slice(0, 7)}${byte}`;
}

/** The token colours Monaco needs, by the handoff's names. */
export type MonacoPalette = Record<'base-100' | 'base-200' | 'base-300' | 'line' | 'line-strong' | 'text' | 'text-muted' | 'text-dim' | 'live' | 'working' | 'needs-you' | 'failed', string>;

/** The editor theme for `colors` (default: the design system's palette). */
export function monacoTheme(colors: MonacoPalette = palette): ThemePack {
    const strip = (hex: string): string => hex.replace('#', '');
    return {
        name: MONACO_THEME,
        data: {
            base: 'vs-dark',
            inherit: true,
            rules: [
                { token: '', foreground: strip(colors.text) },
                { token: 'comment', foreground: strip(colors['text-dim']), fontStyle: 'italic' },
                { token: 'string', foreground: strip(colors.live) },
                { token: 'number', foreground: strip(colors['needs-you']) },
                { token: 'keyword', foreground: strip(colors.working) },
                { token: 'type', foreground: strip(colors.working) },
                { token: 'delimiter', foreground: strip(colors['text-muted']) }
            ],
            colors: {
                'editor.background': colors['base-100'],
                'editor.foreground': colors.text,
                'editorLineNumber.foreground': colors['text-dim'],
                'editorLineNumber.activeForeground': colors.text,
                'editorGutter.background': colors['base-100'],
                'editor.lineHighlightBackground': '#00000000',
                'editor.lineHighlightBorder': '#00000000',
                'editor.selectionBackground': withAlpha(colors.working, 0.25),
                'editor.inactiveSelectionBackground': withAlpha(colors.working, 0.15),
                'editorIndentGuide.background1': colors.line,
                'editorWhitespace.foreground': colors.line,
                'editorWidget.background': colors['base-300'],
                'editorWidget.border': colors['line-strong'],
                'scrollbarSlider.background': withAlpha(colors['line-strong'], 0.6),
                'scrollbarSlider.hoverBackground': colors['line-strong'],
                'scrollbarSlider.activeBackground': colors['text-dim'],
                'diffEditor.insertedLineBackground': withAlpha(colors.live, 0.08),
                'diffEditor.removedLineBackground': withAlpha(colors.failed, 0.08),
                'diffEditor.insertedTextBackground': '#00000000',
                'diffEditor.removedTextBackground': '#00000000',
                'diffEditorGutter.insertedLineBackground': withAlpha(colors.live, 0.08),
                'diffEditorGutter.removedLineBackground': withAlpha(colors.failed, 0.08),
                'diffEditor.border': colors.line,
                'diffEditor.diagonalFill': withAlpha(colors['line-strong'], 0.5),
                'diffEditor.unchangedRegionBackground': colors['base-300'],
                'diffEditor.unchangedRegionForeground': colors['text-dim'],
                'diffEditor.unchangedCodeBackground': '#00000000'
            }
        }
    };
}

/** The font the editor uses: the design system's mono stack at the board's 12 / 22. */
export const MONACO_FONT = { fontFamily: system.typography.fonts.mono, fontSize: 12, lineHeight: 22 } as const;
