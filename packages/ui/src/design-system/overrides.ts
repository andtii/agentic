/**
 * The zero-daisyui recipes, re-tuned to the handoff's element-state table
 * (`docs/design/HANDOFF.md` → "Element states", "Components").
 *
 * Every override REPLACES the daisy recipe for its scope: a second recipe
 * for one scope would compile twice and win by source order, which is a
 * cascade to debug rather than a design decision to read. `withOverride`
 * deep-merges a patch onto the daisy recipe, so a patch states only what
 * the handoff changes and daisy's own reasoning (ink mixes, RTL guards,
 * presence transitions) stays in force underneath.
 */
import type { RecipeInput } from '@sigx/zero-kit';
import { recipes as daisyRecipes } from '@sigx/zero-daisyui';

type Patch = Partial<Omit<RecipeInput, 'component'>>;

const isPlain = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

/** Objects merge per key, recursively; arrays and scalars replace. */
function deepMerge<T>(base: T, patch: unknown): T {
    if (!isPlain(base) || !isPlain(patch)) return (patch === undefined ? base : patch) as T;
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(patch)) out[key] = deepMerge(out[key], value);
    return out as T;
}

/** Replace the recipe for `component` with the daisy recipe patched; throws if daisy has none. */
export function withOverride(recipes: readonly RecipeInput[], component: string, patch: Patch): RecipeInput[] {
    const index = recipes.findIndex((r) => r.component === component);
    if (index < 0) throw new Error(`[@agentic/ui] no daisy recipe for "${component}" to override`);
    const base = recipes[index]!;
    const merged: RecipeInput = deepMerge(base, patch);
    // `compoundVariants` is a list of rules with no address to merge into: the patch ADDS rules.
    if (patch.compoundVariants) merged.compoundVariants = [...(base.compoundVariants ?? []), ...patch.compoundVariants];
    const next = [...recipes];
    next[index] = merged;
    return next;
}

const motion = 'var(--duration-fast) var(--ease-standard)';
/** 2 px primary ring, 2 px offset — the focus treatment of every control. */
const ring = { outline: '2px solid var(--color-primary)', outlineOffset: '2px' };
/** Table row hover: base-300 at 50 %. */
const rowHover = 'color-mix(in oklab, var(--color-base-300) 50%, transparent)';
const mono = 'var(--font-mono)';
/** Column heads, card labels: mono 11 / 500, uppercase, tracking 0.08em. */
const label = {
    fontFamily: mono,
    fontSize: 'var(--text-xs)',
    fontWeight: 'var(--weight-medium)',
    letterSpacing: 'var(--tracking-wider)',
    textTransform: 'uppercase',
    color: 'var(--ag-text-dim)'
};

/**
 * The field chrome the handoff gives every text control: 38 px, base-100
 * fill, `line-strong` border; hover border `text-dim`; focus border `live`
 * with no glow; disabled 60 % and `not-allowed`.
 */
const fieldBase = {
    height: 'var(--ag-input-h)',
    background: 'var(--color-base-100)',
    borderColor: 'var(--ag-line-strong)',
    boxShadow: 'none',
    fontSize: 'var(--text-md)'
};
const fieldStates = {
    hover: { borderColor: 'var(--ag-text-dim)' },
    'focus-visible': { outline: 'none', borderColor: 'var(--color-primary)' },
    disabled: { opacity: '0.6', cursor: 'not-allowed' }
};

let recipes: RecipeInput[] = [...daisyRecipes];

// Button: 36 px, radius 6, 13 / 600, no shadow. Hover/pressed stay daisy's
// brightness steps; the ring is the 2 px primary ring; disabled is the 40 %
// token. `neutral solid` is the handoff's DEFAULT button: base-300 fill,
// `line-strong` border, hover border `text-dim`.
recipes = withOverride(recipes, 'button', {
    parts: {
        root: {
            base: {
                height: 'var(--ag-control-h)',
                gap: 'var(--space-sm)',
                boxShadow: 'none',
                fontSize: 'var(--text-md)',
                transition: `background ${motion}, border-color ${motion}, filter ${motion}`
            },
            states: { 'focus-visible': ring }
        }
    },
    variants: {
        size: { md: { root: { base: { padding: '0 var(--space-lg)', fontSize: 'var(--text-md)' } } } }
    },
    modifiers: {
        loading: { root: { selectors: { '&::before': { inlineSize: '14px', blockSize: '14px' } } } }
    },
    compoundVariants: [
        {
            match: { color: 'neutral', variant: 'solid' },
            parts: {
                root: {
                    base: { borderColor: 'var(--ag-line-strong)' },
                    states: { hover: { filter: 'none', borderColor: 'var(--ag-text-dim)' } }
                }
            }
        }
    ]
});

// Text controls: one field chrome for input, textarea, native select, select and combobox.
recipes = withOverride(recipes, 'input', {
    parts: {
        control: { base: fieldBase, states: fieldStates },
        input: { base: { fontSize: 'var(--text-md)', padding: '0 var(--space-md)' }, selectors: { '&::placeholder': { color: 'var(--ag-text-dim)' } } }
    }
});
recipes = withOverride(recipes, 'textarea', {
    parts: {
        textarea: {
            base: { ...fieldBase, height: 'auto', minHeight: 'calc(var(--ag-input-h) * 2)', padding: 'var(--space-sm) var(--space-md)' },
            states: fieldStates,
            selectors: { '&::placeholder': { color: 'var(--ag-text-dim)' } }
        }
    }
});
recipes = withOverride(recipes, 'native-select', {
    parts: {
        control: { base: { ...fieldBase, padding: '0 var(--space-md)', paddingInlineEnd: 'calc(var(--space-md) + 1.25em)' }, states: fieldStates },
        indicator: { base: { opacity: '1', color: 'var(--ag-text-dim)' } }
    }
});
recipes = withOverride(recipes, 'select', {
    parts: {
        trigger: {
            base: { ...fieldBase, paddingInline: 'var(--space-md)', fontWeight: 'var(--weight-normal)' },
            states: { ...fieldStates, open: { borderColor: 'var(--color-primary)' } }
        },
        popup: { base: { background: 'var(--color-base-300)', borderColor: 'var(--ag-line-strong)', boxShadow: 'var(--shadow-xl)', padding: 'var(--space-xs)' } },
        item: { base: { padding: 'var(--space-sm) var(--space-md)', fontSize: 'var(--text-md)', fontWeight: 'var(--weight-normal)' }, states: { highlighted: { background: 'var(--color-base-100)' } } }
    }
});
recipes = withOverride(recipes, 'combobox', {
    parts: {
        control: { base: fieldBase, states: { ...fieldStates, open: { borderColor: 'var(--color-primary)' } } },
        input: { base: { fontSize: 'var(--text-md)', fontWeight: 'var(--weight-normal)', padding: '0 var(--space-md)' }, selectors: { '&::placeholder': { color: 'var(--ag-text-dim)' } } },
        popup: { base: { background: 'var(--color-base-300)', borderColor: 'var(--ag-line-strong)', boxShadow: 'var(--shadow-xl)', padding: 'var(--space-xs)' } },
        item: { base: { padding: 'var(--space-sm) var(--space-md)', fontSize: 'var(--text-md)', fontWeight: 'var(--weight-normal)' }, states: { highlighted: { background: 'var(--color-base-100)' } } }
    }
});

// Field: label 12 / 600 muted above, hint 12 dim below, error 12 in `failed`.
recipes = withOverride(recipes, 'field', {
    parts: {
        root: { base: { gap: 'var(--space-xs)' } },
        label: { base: { fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-semibold)', color: 'var(--ag-text-muted)' } },
        description: { base: { fontSize: 'var(--text-sm)', color: 'var(--ag-text-dim)', opacity: '1' } },
        error: { base: { fontSize: 'var(--text-sm)', color: 'var(--color-error)', fontWeight: 'var(--weight-normal)' } }
    }
});

// Switch: 40 × 24 (daisy's size × 6 with the selector unit), off = base-300 track, on = `live` track with a `live-ink` knob.
recipes = withOverride(recipes, 'switch', {
    parts: {
        control: {
            base: { backgroundColor: 'var(--color-base-300)', boxShadow: 'none', borderColor: 'var(--ag-line-strong)' },
            states: {
                checked: { backgroundColor: 'var(--switch-accent)', borderColor: 'var(--switch-accent)', color: 'var(--color-base-100)' },
                'focus-visible': ring
            }
        },
        thumb: { base: { boxShadow: 'none', borderRadius: '9999px' } }
    }
});

// Badge: the 22 px mono pill every status pill and tag is built on.
recipes = withOverride(recipes, 'badge', {
    tokens: { '--badge-fill': 'transparent', '--badge-ink': 'var(--ag-text-muted)' },
    parts: {
        root: {
            base: {
                height: 'var(--ag-pill-h)',
                padding: '0 var(--space-sm)',
                borderColor: 'var(--ag-line-strong)',
                fontFamily: mono,
                fontSize: 'var(--text-xs)',
                fontWeight: 'var(--weight-medium)',
                letterSpacing: 'var(--tracking-wide)',
                lineHeight: 'var(--leading-none)'
            }
        }
    }
});

// Dialog: 520 px on base-300, radius 10, padding 24, the only shadow in the system, a 160 ms rise.
recipes = withOverride(recipes, 'dialog', {
    parts: {
        popup: {
            base: {
                padding: 'var(--space-2xl)',
                maxWidth: '520px',
                background: 'var(--color-base-300)',
                borderRadius: 'var(--ag-radius-xl)',
                border: 'var(--border) solid var(--ag-line-strong)'
            },
            states: { open: { animation: 'zero-daisy-pop var(--duration-fast) var(--ease-standard)' } }
        },
        backdrop: { base: { background: 'oklch(3% 0.005 160 / 0.7)' } },
        title: { base: { fontSize: 'var(--text-xl)', fontWeight: 'var(--weight-semibold)', marginBlockEnd: 'var(--space-sm)' } },
        description: { base: { color: 'var(--ag-text-muted)', marginBlockEnd: 'var(--space-xl)', fontSize: 'var(--text-md)' } },
        footer: { base: { gap: 'var(--space-sm)', marginBlockStart: 'var(--space-2xl)', flexWrap: 'wrap' } }
    }
});

// Table: base-200 box with `line` borders; head 10 / 16 in the mono label voice, body 14 / 16, hover base-300 at 50 %.
recipes = withOverride(recipes, 'table', {
    tokens: { '--table-pad-block': '14px', '--table-pad-inline': 'var(--space-lg)', '--table-font': 'var(--text-lg)' },
    parts: {
        root: { base: { border: 'var(--border) solid var(--ag-line)', background: 'var(--color-base-200)' } },
        row: { base: { borderBlockEnd: 'var(--border) solid var(--ag-line)' } },
        'header-cell': { base: { ...label, padding: '10px var(--table-pad-inline)' } },
        caption: { base: { ...label, padding: 'var(--space-md) var(--table-pad-inline)' } }
    },
    modifiers: {
        hover: { row: { selectors: { '[data-scope="table"][data-part="body"] > &:hover:not([data-selected])': { background: rowHover } } } }
    }
});

// Timeline: 8 px dot in the state colour, 1 px `line-strong` connector, plain text content.
recipes = withOverride(recipes, 'timeline', {
    tokens: { '--timeline-marker-size': 'var(--space-sm)', '--timeline-accent': 'var(--ag-text-muted)' },
    parts: {
        connector: { base: { background: 'var(--ag-line-strong)' } },
        content: { base: { border: 'none', background: 'transparent', padding: '0', margin: '0 var(--space-md) var(--space-md)', fontSize: 'var(--text-md)' } }
    }
});

// Card: base-200 with a `line` border, radius 8, padding 20, no shadow.
recipes = withOverride(recipes, 'card', {
    tokens: { '--card-pad': 'var(--space-xl)' },
    parts: {
        root: { base: { background: 'var(--color-base-200)', border: 'var(--border) solid var(--ag-line)', boxShadow: 'none' } },
        title: { base: { fontSize: 'var(--text-xl)' } },
        description: { base: { color: 'var(--ag-text-muted)', fontSize: 'var(--text-md)' } },
        body: { base: { fontSize: 'var(--text-md)' } }
    }
});

// Breadcrumbs: 15 / 600 current, 500 parent in `text-muted`, `text-dim` chevrons.
recipes = withOverride(recipes, 'breadcrumbs', {
    parts: {
        root: { base: { fontSize: '15px' } },
        list: { base: { gap: 'var(--space-sm)', padding: '0' } },
        item: { base: { gap: 'var(--space-sm)' } },
        link: {
            base: { color: 'var(--ag-text-muted)', fontWeight: 'var(--weight-medium)' },
            states: { hover: { color: 'var(--color-base-content)', textDecoration: 'none' }, active: { color: 'var(--color-base-content)' }, 'focus-visible': ring }
        },
        separator: { base: { color: 'var(--ag-text-dim)', fontSize: 'var(--text-lg)' } }
    }
});

// Tabs: an underline bar — the tab strip of the agent page.
recipes = withOverride(recipes, 'tabs', {
    parts: {
        list: { base: { alignSelf: 'stretch', padding: '0', gap: '0', background: 'transparent', borderRadius: '0', borderBlockEnd: 'var(--border) solid var(--ag-line)' } },
        tab: {
            base: {
                padding: 'var(--space-md) var(--space-lg)',
                fontSize: 'var(--text-md)',
                color: 'var(--ag-text-muted)',
                borderRadius: '0',
                borderBlockEnd: '2px solid transparent',
                marginBlockEnd: '-1px',
                transition: `color ${motion}, border-color ${motion}`
            },
            states: { active: { background: 'transparent', boxShadow: 'none', color: 'var(--color-base-content)', borderBlockEndColor: 'var(--color-primary)' }, 'focus-visible': ring }
        }
    }
});

// Collapsible: the borderless disclosure a reasoning block folds on — chevron + "Reasoning · 6s" in `text-dim`.
recipes = withOverride(recipes, 'collapsible', {
    parts: {
        root: { base: { border: 'none', borderRadius: '0', background: 'transparent' } },
        trigger: {
            base: { padding: 'var(--space-2xs) 0', fontSize: 'var(--text-md)', fontWeight: 'var(--weight-normal)', color: 'var(--ag-text-dim)', justifyContent: 'flex-start', gap: 'var(--space-sm)' },
            states: { hover: { background: 'transparent', color: 'var(--color-base-content)' }, 'focus-visible': ring },
            selectors: { '&::after': { width: '0.35rem', height: '0.35rem', opacity: '1' } }
        },
        panel: { base: { padding: 'var(--space-sm) 0 0', fontSize: 'var(--text-md)' } }
    }
});

// Toggle group: the segmented control — a 2 px inset track on base-100, 30 px segments, selected = base-300.
recipes = withOverride(recipes, 'toggle-group', {
    tokens: { '--toggle-group-accent': 'var(--color-base-300)', '--toggle-group-on-accent': 'var(--color-base-content)' },
    parts: {
        root: { base: { background: 'var(--color-base-100)', border: 'var(--border) solid var(--ag-line-strong)', padding: 'var(--space-2xs)', gap: 'var(--space-2xs)', boxShadow: 'none' } },
        item: {
            base: { height: '30px', padding: '0 var(--space-md)', fontSize: 'var(--text-md)', borderRadius: 'var(--radius-selector)', color: 'var(--ag-text-muted)' },
            states: { hover: { background: 'transparent', color: 'var(--color-base-content)' }, 'focus-visible': { outline: '2px solid var(--color-primary)', outlineOffset: '-2px' } },
            selectors: {
                '&[data-state="on"]:hover': { filter: 'none' },
                '&[data-orientation="horizontal"] + &': { borderInlineStart: '0' },
                '&[data-orientation="vertical"] + &': { borderBlockStart: '0' }
            }
        }
    },
    defaultVariants: { color: 'neutral' }
});

// Skeleton: 14 px bars in `line`.
recipes = withOverride(recipes, 'skeleton', {
    tokens: { '--skeleton-fill': 'var(--ag-line)' },
    parts: { root: { base: { borderRadius: 'var(--radius-selector)', minBlockSize: '14px' } } }
});

// Navbar: the shell's topbar row — 60 px, no fill of its own (shell.css paints the bar).
recipes = withOverride(recipes, 'navbar', {
    parts: {
        root: { base: { minBlockSize: 'var(--ag-topbar-h)', padding: '0', background: 'transparent', gap: 'var(--space-md)' } },
        end: { base: { gap: '10px' } }
    }
});

/** daisy's recipes with the handoff's overrides applied, one per scope. */
export const overriddenRecipes: readonly RecipeInput[] = recipes;
