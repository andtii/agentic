/**
 * The `agentic` design system, held to what the kit checks (validation
 * against zero's manifest with the fragment merged) and to what it does not:
 * the kit contrast-checks role / `-content` and base pairs only, so the
 * `--ag-*` inks the handoff relies on are measured here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileTokensCss, mergeManifests, validateDesignSystem, type ZeroManifest } from '@sigx/zero-kit';
import { AGENT_HUES, AG_MODIFIERS, KINDS, THEME, TONES, custom, designSystem, palette, tokens } from '../src/design-system';
import { fragment } from '../src/fragment';

const zeroManifest = JSON.parse(readFileSync(fileURLToPath(import.meta.resolve('@sigx/zero/manifest.json')), 'utf8')) as ZeroManifest;
// A path, not `new URL(...)`: happy-dom replaces the global URL, which node:fs refuses.
const handoff = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'docs', 'design', 'tokens.json'), 'utf8')) as {
    color: Record<string, string>;
    agentHue: string[];
    size: Record<string, number>;
};

const theme = tokens.themes[THEME]!;

/** WCAG 2.x relative luminance of a `#rrggbb`. */
function luminance(hex: string): number {
    const c = hex.replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => {
        const v = parseInt(c.slice(i, i + 2), 16) / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
};

describe('the agentic design system', () => {
    it('validates against zero\'s manifest with the ai-* fragment merged, with no errors', () => {
        const result = validateDesignSystem(designSystem, mergeManifests(zeroManifest, fragment));
        expect(result.errors).toEqual([]);
        expect(result.ok).toBe(true);
        // Every declared axis value and modifier is wired by a recipe (kit #85, states #87): strict mode holds.
        expect(result.warnings).toEqual([]);
    });

    it('ships exactly one theme, dark, as both scheme defaults', () => {
        expect(Object.keys(tokens.themes)).toEqual([THEME]);
        expect(theme.colorScheme).toBe('dark');
        expect(tokens.defaultLight).toBe(THEME);
        expect(tokens.defaultDark).toBe(THEME);
    });

    it('takes every colour from docs/design/tokens.json', () => {
        expect(theme.colors['base-100']).toBe(handoff.color['base-100']);
        expect(theme.colors['base-200']).toBe(handoff.color['base-200']);
        expect(theme.colors['base-300']).toBe(handoff.color['base-300']);
        expect(theme.colors['base-content']).toBe(handoff.color['text']);
        expect(theme.colors.primary).toBe(handoff.color['live']);
        expect(theme.colors.success).toBe(handoff.color['live']);
        expect(theme.colors['primary-content']).toBe(handoff.color['live-ink']);
        expect(theme.colors.info).toBe(handoff.color['working']);
        expect(theme.colors.warning).toBe(handoff.color['needs-you']);
        expect(theme.colors['warning-content']).toBe(handoff.color['needs-you-ink']);
        expect(theme.colors.error).toBe(handoff.color['failed']);
        expect(theme.custom!['ag-line']).toBe(handoff.color['line']);
        expect(theme.custom!['ag-line-strong']).toBe(handoff.color['line-strong']);
        expect(theme.custom!['ag-text-muted']).toBe(handoff.color['text-muted']);
        expect(theme.custom!['ag-text-dim']).toBe(handoff.color['text-dim']);
        expect(theme.custom!['ag-link-hover']).toBe(handoff.color['link-hover']);
        expect([...AGENT_HUES]).toEqual(handoff.agentHue);
        expect(theme.custom!['ag-control-h']).toBe(`${handoff.size['control-h']}px`);
        expect(theme.custom!['ag-input-h']).toBe(`${handoff.size['input-h']}px`);
        expect(theme.custom!['ag-control-h-touch']).toBe(`${handoff.size['control-h-touch']}px`);
        expect(theme.custom!['ag-touch-min']).toBe(`${handoff.size['touch-min']}px`);
        expect(theme.custom!['ag-pill-h']).toBe(`${handoff.size['pill-h']}px`);
        expect(theme.custom!['ag-sidebar-w']).toBe(`${handoff.size['sidebar-w']}px`);
        expect(theme.custom!['ag-topbar-h']).toBe(`${handoff.size['topbar-h']}px`);
    });

    it('gives every declared custom token a value in the theme, and emits each --ag-* into tokens.css', () => {
        for (const name of Object.keys(custom)) expect(theme.custom![name], name).toBeTruthy();
        const css = compileTokensCss(tokens);
        for (const [name, value] of Object.entries(theme.custom!)) {
            if (name.startsWith('ag-')) expect(css).toContain(`--${name}: ${value};`);
        }
        expect(css).toMatch(/\[data-theme="control-room"\]\s*\{\s*color-scheme: dark;/);
        expect(css).toContain('--font-sans: \'Schibsted Grotesk\'');
        expect(css).toContain('--space-2xs: 2px;');
        expect(css).toContain('--text-md: 13px;');
    });

    it('keeps the handoff\'s inks readable where the kit does not measure them', () => {
        // text-dim is the floor: 4.6:1 on base-300 per the handoff; do not go darker.
        expect(contrast(palette['text-dim'], palette['base-300'])).toBeGreaterThanOrEqual(4.5);
        expect(contrast(palette['text-muted'], palette['base-200'])).toBeGreaterThanOrEqual(4.5);
        expect(contrast(palette.text, palette['base-100'])).toBeGreaterThanOrEqual(7);
        // The monogram on a tile is text at 3:1 minimum against the sidebar / card surface.
        for (const hue of AGENT_HUES) expect(contrast(hue, palette['base-200']), hue).toBeGreaterThanOrEqual(3);
        // The four state colours each read as ink on the page ground.
        for (const ink of [palette.live, palette.working, palette['needs-you'], palette.failed]) {
            expect(contrast(ink, palette['base-100']), ink).toBeGreaterThanOrEqual(4.5);
        }
    });

    it('declares the product axes and modifiers the kit issues wire, beside daisy\'s', () => {
        expect(tokens.axes).toEqual({ tone: [...TONES], kind: [...KINDS] });
        for (const mod of AG_MODIFIERS) expect(tokens.modifiers).toContain(mod);
        for (const mod of ['wide', 'block', 'square', 'circle', 'active', 'loading', 'zebra', 'hover']) expect(tokens.modifiers).toContain(mod);
        expect(tokens.variants).toEqual(['solid', 'outline', 'soft', 'ghost', 'dash', 'link']);
    });

    it('overrides daisy\'s recipes in place — one recipe per scope, daisy\'s axes intact', () => {
        const scopes = designSystem.recipes.map((r) => r.component);
        expect(new Set(scopes).size).toBe(scopes.length);
        for (const scope of fragment.components.map((c) => c.scope)) expect(scopes).toContain(scope);
        const button = designSystem.recipes.find((r) => r.component === 'button')!;
        expect(button.parts['root']!.base!['height']).toBe('var(--ag-control-h)');
        expect(button.parts['root']!.states!['focus-visible']!['outline']).toBe('2px solid var(--color-primary)');
        expect(Object.keys(button.variants!['color']!)).toContain('neutral');
        expect(button.variants!['variant']!['outline']).toBeDefined();
        expect(button.compoundVariants?.some((c) => c.match['color'] === 'neutral' && c.match['variant'] === 'solid')).toBe(true);
        const badge = designSystem.recipes.find((r) => r.component === 'badge')!;
        expect(badge.parts['root']!.base!['height']).toBe('var(--ag-pill-h)');
        expect(badge.parts['root']!.base!['fontFamily']).toBe('var(--font-mono)');
    });
});
