/**
 * Fallbacks for the custom properties the recipe pack reads, applied once at
 * the fragment boundary (`fragment/index.ts`).
 *
 * `sigx zero:fragment` compiles the pack for lynx against a vocabulary with
 * no spacing ramp, no typography and no `--ag-*` tokens. On lynx an
 * unresolvable `var()` does not fall back: the declaration is dropped and the
 * element paints nothing, so the gate refuses every bare reference to a
 * property the probe does not define. The recipe files read about a thousand
 * bare `var()`s, so rather than hand-edit them, `withFallbacks` rewrites
 * `var(--x)` to `var(--x, <fallback>)` for each name in a table.
 *
 * Only the exported pack is rewritten. The agentic design system compiles the
 * recipe files untouched, since it defines every one of these properties and
 * the fallbacks would never apply there.
 *
 * Pure data and string work: no kit or sigx runtime import, so the fragment
 * entry still loads in Node on its own.
 */

/**
 * The kit's standard vocabulary, at zero-daisyui's defaults
 * (`@sigx/zero-daisyui` `tokens.system`), plus the few steps agentic adds to
 * daisy's ramps. Only needed until the lynx probe
 * defines it itself (signalxjs/zero#158); the table then shrinks
 * to {@link AG_FALLBACKS}.
 */
export const KIT_FALLBACKS: Readonly<Record<string, string>> = {
    '--space-2xs': '0.125rem',
    '--space-xs': '0.25rem',
    '--space-sm': '0.375rem',
    '--space-md': '0.5rem',
    '--space-lg': '0.75rem',
    '--space-xl': '1rem',
    '--space-2xl': '1.25rem',
    '--font-sans': 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    '--font-mono': 'ui-monospace, SFMono-Regular, Menlo, monospace',
    '--weight-normal': '400',
    '--weight-medium': '500',
    '--weight-semibold': '600',
    '--weight-bold': '700',
    '--leading-none': '1',
    '--leading-tight': '1.25',
    '--leading-normal': '1.5',
    '--tracking-normal': '0em',
    '--tracking-wide': '0.05em',
    '--duration-instant': '100ms',
    '--duration-fast': '150ms',
    '--duration-normal': '200ms',
    '--duration-slow': '300ms',
    '--ease-standard': 'ease',
    '--shadow-xs': '0 1px 2px oklch(0% 0 0 / 0.08)',
    '--shadow-sm': '0 1px 2px oklch(0% 0 0 / 0.15)',
    '--shadow-md': '0 1px 2px oklch(0% 0 0 / 0.2)',
    '--shadow-lg': '0 12px 32px -8px oklch(0% 0 0 / 0.3)',
    '--shadow-xl': '0 25px 50px -12px oklch(0% 0 0 / 0.4)',
    // The steps the agentic design system adds to daisy's ramps, at its own
    // values. The probe's fitter snaps a step its vocabulary lacks to the
    // nearest declared one, so a bare `var(--tracking-wider)` would reach
    // the lynx check as a bare `var(--tracking-normal)`.
    '--leading-relaxed': '1.6',
    '--tracking-tight': '-0.01em',
    '--tracking-wider': '0.08em',
    '--ease-linear': 'linear',
    '--ease-emphasized': 'cubic-bezier(0.2, 0, 0, 1)'
};

/** The handoff's `--ag-*` tokens, at the `control-room` values (`design-system/tokens.ts`). */
export const AG_FALLBACKS: Readonly<Record<string, string>> = {
    '--ag-line': '#252B29',
    '--ag-line-strong': '#343C39',
    '--ag-text-muted': '#A3ADA8',
    '--ag-text-dim': '#7F8A85',
    '--ag-link-hover': '#DDF89B',
    '--ag-agent-1': '#B9A5F5',
    '--ag-agent-2': '#F5A36B',
    '--ag-agent-3': '#F08FB4',
    '--ag-agent-4': '#7FB2F5',
    '--ag-radius-xl': '10px',
    '--ag-control-h': '36px',
    '--ag-input-h': '38px',
    '--ag-control-h-touch': '48px',
    '--ag-touch-min': '44px',
    '--ag-pill-h': '22px',
    '--ag-sidebar-w': '232px',
    '--ag-topbar-h': '60px',
    '--ag-space-8': '28px'
};

/** Every fallback the exported pack carries. */
export const FALLBACKS: Readonly<Record<string, string>> = { ...KIT_FALLBACKS, ...AG_FALLBACKS };

/** A bare reference, `var(--x)`, with no fallback of its own. */
const BARE_VAR = /var\(\s*(--[A-Za-z0-9_-]+)\s*\)/g;

/** `var(--x)` → `var(--x, <fallback>)` for each name in `table`; an existing fallback is left as is. */
function rewrite(css: string, table: Readonly<Record<string, string>>): string {
    return css.replace(BARE_VAR, (whole, name: string) => {
        const fallback = Object.hasOwn(table, name) ? table[name] : undefined;
        return fallback === undefined ? whole : `var(${name}, ${fallback})`;
    });
}

/**
 * A copy of `value` with every string in it (recipe values at any depth, or a
 * raw CSS string) rewritten so each bare `var(--x)` named in `table` carries
 * its fallback. Object keys are left alone. A nested bare reference is
 * rewritten in place (`var(--a, var(--space-md))` gains the inner fallback).
 */
export function withFallbacks<T>(value: T, table: Readonly<Record<string, string>>): T {
    if (typeof value === 'string') return rewrite(value, table) as T;
    if (Array.isArray(value)) return value.map((item: unknown) => withFallbacks(item, table)) as T;
    if (typeof value === 'object' && value !== null) {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withFallbacks(item as unknown, table)])) as T;
    }
    return value;
}
