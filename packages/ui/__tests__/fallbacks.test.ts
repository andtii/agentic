import { describe, it, expect } from 'vitest';
import { tokens as daisy } from '@sigx/zero-daisyui';
import { AG_FALLBACKS, FALLBACKS, KIT_FALLBACKS, withFallbacks } from '../src/fragment/fallbacks';
import { fragmentCss, recipes } from '../src/fragment';
import { recipes as transcriptRecipes } from '../src/fragment/recipes';
import { custom, system, THEME, tokens } from '../src/design-system';

const TABLE = { '--space-md': '0.5rem', '--ag-line': '#252B29' };

/** The kit-vocabulary custom properties a `SystemTokens` declaration defines, by category. */
function vocabulary(s: typeof daisy.system | typeof system): Record<string, string> {
    const out: Record<string, string> = {};
    const add = (prefix: string, scale: Record<string, string | number> | undefined) => {
        for (const [step, value] of Object.entries(scale ?? {})) out[`--${prefix}-${step}`] = String(value);
    };
    add('space', s?.spacing);
    add('font', s?.typography?.fonts);
    add('weight', s?.typography?.weights);
    add('leading', s?.typography?.leading);
    add('tracking', s?.typography?.tracking);
    add('duration', s?.motion?.durations);
    add('ease', s?.motion?.easings);
    add('shadow', s?.shadow);
    return out;
}

describe('withFallbacks', () => {
    it('gives a bare var() named in the table its fallback', () => {
        expect(withFallbacks('padding: var(--space-md) var(--space-md)', TABLE)).toBe('padding: var(--space-md, 0.5rem) var(--space-md, 0.5rem)');
        expect(withFallbacks('var( --ag-line )', TABLE)).toBe('var(--ag-line, #252B29)');
    });

    it('rewrites a nested bare reference in place', () => {
        expect(withFallbacks('var(--ag-ink, var(--ag-line))', TABLE)).toBe('var(--ag-ink, var(--ag-line, #252B29))');
        expect(withFallbacks('calc(var(--space-md) * 2)', TABLE)).toBe('calc(var(--space-md, 0.5rem) * 2)');
    });

    it('leaves an existing fallback, and a name outside the table, as they are', () => {
        expect(withFallbacks('var(--space-md, 4px)', TABLE)).toBe('var(--space-md, 4px)');
        expect(withFallbacks('var(--ag-line, var(--color-base-300))', TABLE)).toBe('var(--ag-line, var(--color-base-300))');
        expect(withFallbacks('var(--text-sm) var(--space-md-2)', TABLE)).toBe('var(--text-sm) var(--space-md-2)');
    });

    it('walks every string value at any depth, leaving keys and non-strings alone, without mutating the input', () => {
        const input = { base: { gap: 'var(--space-md)', '--x': 'var(--ag-line)', order: 1, hidden: false }, list: ['var(--space-md)', null] };
        const out = withFallbacks(input, TABLE);
        expect(out).toEqual({ base: { gap: 'var(--space-md, 0.5rem)', '--x': 'var(--ag-line, #252B29)', order: 1, hidden: false }, list: ['var(--space-md, 0.5rem)', null] });
        expect(input.base.gap).toBe('var(--space-md)');
    });
});

describe('the fallback table', () => {
    it('carries zero-daisyui\'s value for every step of the kit vocabulary daisy declares', () => {
        const fromDaisy = vocabulary(daisy.system);
        expect(Object.keys(fromDaisy).length).toBeGreaterThan(20);
        for (const [name, value] of Object.entries(fromDaisy)) expect(KIT_FALLBACKS[name], name).toBe(value);
    });

    it('carries agentic\'s own value for the steps it adds to daisy\'s ramps', () => {
        const fromDaisy = vocabulary(daisy.system);
        const agentic = vocabulary(system);
        for (const name of Object.keys(KIT_FALLBACKS).filter((n) => !(n in fromDaisy))) expect(KIT_FALLBACKS[name], name).toBe(agentic[name]);
        for (const name of Object.keys(agentic).filter((n) => !(n in fromDaisy))) expect(KIT_FALLBACKS[name], name).toBeDefined();
    });

    it('carries the control-room value of every --ag-* token', () => {
        const values = tokens.themes[THEME]!.custom as Record<string, string>;
        const names = Object.keys(custom).filter((n) => n.startsWith('ag-'));
        expect(Object.keys(AG_FALLBACKS).sort()).toEqual(names.map((n) => `--${n}`).sort());
        for (const name of names) expect(AG_FALLBACKS[`--${name}`], name).toBe(values[name]);
    });
});

describe('the exported pack', () => {
    it('reads no name of the table without a fallback', () => {
        const bare = [...JSON.stringify([recipes, fragmentCss]).matchAll(/var\(\s*(--[A-Za-z0-9_-]+)\s*\)/g)].map((m) => m[1]!);
        expect(bare.filter((name) => name in FALLBACKS)).toEqual([]);
    });

    it('leaves the recipe files the design system compiles untouched', () => {
        expect(JSON.stringify(transcriptRecipes)).toMatch(/var\(--space-sm\)/);
        expect(JSON.stringify(recipes)).not.toMatch(/var\(--space-sm\)/);
    });
});
