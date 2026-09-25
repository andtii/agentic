/**
 * The `agentic` design system, held to what the kit checks (validation
 * against zero's manifest with the fragment merged) and to what it does not:
 * the recipes are daisy's patched per scope by `extendDesignSystem`, and the
 * `--ag-*` inks' contrast floors are declared in `tokens.contrast`, where the
 * kit measures them.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileTokensCss, mergeManifests, validateDesignSystem, type ZeroManifest } from '@sigx/zero-kit';
import { AGENT_HUES, AG_MODIFIERS, KINDS, THEME, TONES, custom, designSystem, patches, tokens } from '../src/design-system';
import { fragment } from '../src/fragment';
import { tokens as daisy } from '@sigx/zero-daisyui';
import { designSystem as daisyDesignSystem } from '@sigx/zero-daisyui/design-system';

const zeroManifest = JSON.parse(readFileSync(fileURLToPath(import.meta.resolve('@sigx/zero/manifest.json')), 'utf8')) as ZeroManifest;
// A path, not `new URL(...)`: happy-dom replaces the global URL, which node:fs refuses.
const handoff = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'docs', 'design', 'tokens.json'), 'utf8')) as {
    color: Record<string, string>;
    agentHue: string[];
    size: Record<string, number>;
};

const theme = tokens.themes[THEME]!;

describe('the agentic design system', () => {
    it('validates against zero\'s manifest with the ai-* fragment merged, with no errors', () => {
        const result = validateDesignSystem(designSystem, mergeManifests(zeroManifest, fragment));
        expect(result.errors).toEqual([]);
        expect(result.ok).toBe(true);
        // Every declared axis value and modifier is wired by a recipe (kit #85, states #87): strict mode holds.
        expect(result.warnings).toEqual([]);
    });

    it('ships exactly one theme, dark, as the single-scheme default', () => {
        expect(Object.keys(tokens.themes)).toEqual([THEME]);
        expect(theme.colorScheme).toBe('dark');
        expect(tokens.defaultLight).toBe(THEME);
        expect(tokens.defaultDark).toBeUndefined();
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
        // The kit states the dark default's own scheme on :root — no `color-scheme: light`.
        expect(css).not.toMatch(/color-scheme: light/);
        expect(css).toContain('--font-sans: \'Schibsted Grotesk\'');
        expect(css).toContain('--space-2xs: 2px;');
        expect(css).toContain('--text-md: 13px;');
    });

    it('declares the handoff\'s contrast floors in tokens.contrast, for the kit to measure in every theme', () => {
        const pairs = (designSystem.tokens.contrast ?? []).map(({ fg, bg, min }) => `${fg} / ${bg} >= ${min}`);
        expect(pairs).toEqual([
            'ag-text-dim / color-base-300 >= 4.5',
            'ag-text-muted / color-base-200 >= 4.5',
            'color-base-content / color-base-100 >= 7',
            'ag-agent-1 / color-base-200 >= 3',
            'ag-agent-2 / color-base-200 >= 3',
            'ag-agent-3 / color-base-200 >= 3',
            'ag-agent-4 / color-base-200 >= 3',
            'color-primary / color-base-100 >= 4.5',
            'color-info / color-base-100 >= 4.5',
            'color-warning / color-base-100 >= 4.5',
            'color-error / color-base-100 >= 4.5'
        ]);
        // A floor the theme misses fails validation — the kit really measures the pairs.
        const broken = { ...designSystem, tokens: { ...designSystem.tokens, contrast: [{ fg: 'ag-text-dim', bg: 'color-base-300', min: 10 }] } };
        const result = validateDesignSystem(broken, mergeManifests(zeroManifest, fragment));
        expect(result.errors.map((e) => e.rule)).toContain('contrast-floor');
    });

    it('declares the product axes and modifiers the kit issues wire, beside daisy\'s', () => {
        expect(tokens.axes).toEqual({ ...daisy.axes, tone: [...TONES], kind: [...KINDS] });
        // daisy's ramp, plus the handoff's 1280 regime.
        expect(tokens.breakpoints).toEqual({ ...daisy.breakpoints, xl: '80rem' });
        expect(compileTokensCss(tokens)).toContain('--breakpoint-xl: 80rem;');
        for (const mod of AG_MODIFIERS) expect(tokens.modifiers).toContain(mod);
        for (const mod of ['wide', 'block', 'square', 'circle', 'active', 'zebra', 'hover']) expect(tokens.modifiers).toContain(mod);
        for (const v of ['solid', 'outline', 'soft', 'ghost', 'dash', 'link']) expect(tokens.variants).toContain(v);
    });

    it('is derived from daisy by extendDesignSystem — the control-room tokens, one theme, daisy\'s api carried', () => {
        expect(designSystem.derivedFrom?.name).toBe(daisyDesignSystem.name);
        expect(Object.keys(designSystem.derivedFrom!.patches).sort()).toEqual(Object.keys(patches).sort());
        const derived = designSystem.tokens;
        expect(Object.keys(derived.themes)).toEqual([THEME]);
        expect(derived.defaultLight).toBe(THEME);
        expect(derived.defaultDark).toBeUndefined();
        expect(derived.themes[THEME]).toEqual(tokens.themes[THEME]);
        expect(derived.custom).toEqual(tokens.custom);
        expect(derived.system).toEqual(tokens.system);
        expect(derived.breakpoints).toEqual(tokens.breakpoints);
        expect(derived.modifiers).toEqual(tokens.modifiers);
        expect(designSystem.api).toBe(daisyDesignSystem.api);
    });

    it('holds one patch per re-tuned scope, plus the empty stubs later issues fill', () => {
        const tuned = ['button', 'input', 'textarea', 'select', 'combobox', 'field', 'switch', 'badge', 'dialog', 'table', 'timeline', 'card', 'breadcrumbs', 'tabs', 'collapsible', 'toggle-group', 'skeleton', 'navbar', 'drawer', 'nav-list', 'avatar', 'empty-state', 'progress'];
        const stubs = ['alert'];
        expect(Object.keys(patches).sort()).toEqual([...tuned, ...stubs].sort());
        for (const scope of tuned) expect(Object.keys(patches[scope]!).length, scope).toBeGreaterThan(0);
        for (const scope of stubs) expect(patches[scope], scope).toEqual({});
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

    it('marks the active tab once: our square underline, daisy\'s border-flavor bar and rounding dropped (#700)', () => {
        const tabs = designSystem.recipes.find((r) => r.component === 'tabs')!;
        expect(tabs.defaultVariants?.['variant']).toBe('border');
        expect(tabs.parts['tab']!.base!['borderRadius']).toBe('0');
        expect(tabs.parts['tab']!.states!['active']!['borderBlockEndColor']).toBe('var(--color-primary)');
        expect(tabs.variants!['variant']!['border']).toEqual({});
    });
});
