/**
 * Recipes for the session files and changes scopes (#563): measurements read
 * off the `Changes` and `Files` artboards (`docs/design/artboards/*.dc.html`),
 * colours only through the design system's tokens. Pure data.
 *
 * Diff tints are the handoff's one exception to "colour only means state":
 * added rows are `live` at 8 %, removed rows `failed` at 8 %, markers in full.
 */
import type { RecipeInput } from '@sigx/zero-kit';

const mono = 'var(--font-mono)';
const motion = 'var(--duration-fast) var(--ease-standard)';
const ring = { outline: '2px solid var(--color-primary)', outlineOffset: '2px' };
const ellipsis = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minInlineSize: '0' };
const bare = { appearance: 'none', border: 'none', background: 'transparent', font: 'inherit', textAlign: 'start', cursor: 'pointer', padding: '0', color: 'inherit' };
const label = { margin: '0', fontFamily: mono, fontSize: 'var(--text-xs)', fontWeight: 'var(--weight-medium)', letterSpacing: 'var(--tracking-wider)', textTransform: 'uppercase', color: 'var(--ag-text-dim)' };

/** Row tints by `data-tone` (set per row). */
const tint = (ink: string): Record<string, string> => ({ background: `color-mix(in oklab, ${ink} 8%, transparent)` });

/** The plain code surface: 22 px mono rows on the page ground. */
const code: RecipeInput = {
    component: 'ag-code',
    tokens: { '--ag-code-row': '22px' },
    parts: {
        root: {
            base: { display: 'block', flex: '1 1 auto', overflow: 'auto', minInlineSize: '0', minBlockSize: '0', padding: 'var(--space-sm) 0', fontFamily: mono, fontSize: 'var(--text-sm)', color: 'var(--color-base-content)', background: 'var(--color-base-100)' },
            selectors: { '&[data-kind="viewer"]': { paddingBlock: '10px' } }
        },
        row: {
            base: { display: 'grid', gridTemplateColumns: '48px 48px 20px minmax(max-content, 1fr)', alignItems: 'center', minBlockSize: 'var(--ag-code-row)', minInlineSize: '100%', inlineSize: 'max-content' },
            selectors: {
                '[data-kind="viewer"] > &': { gridTemplateColumns: '56px 3px minmax(max-content, 1fr)', columnGap: 'var(--space-md)' },
                '[data-mode="split"] > &': { gridTemplateColumns: '48px 20px minmax(0, 1fr) 48px 20px minmax(0, 1fr)', inlineSize: '100%' },
                '&[data-tone="live"]': tint('var(--color-primary)'),
                '&[data-tone="failed"]': tint('var(--color-error)'),
                '&[data-hunk]': { background: 'var(--color-base-300)', color: 'var(--ag-text-dim)' },
                // The line a question is being asked about.
                '&[data-selected]': { boxShadow: 'inset 2px 0 0 var(--color-warning)' }
            }
        },
        num: {
            base: { ...bare, cursor: 'default', blockSize: '100%', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingInlineEnd: '10px', fontFamily: mono, fontSize: 'var(--text-xs)', color: 'var(--ag-text-dim)', userSelect: 'none', fontVariantNumeric: 'tabular-nums' },
            selectors: {
                '[data-kind="viewer"] &': { paddingInlineEnd: '0' },
                '&:is(button)': { cursor: 'pointer' },
                '&:is(button):hover': { color: 'var(--color-base-content)' },
                '&:is(button):focus-visible': { ...ring, outlineOffset: '-2px' }
            }
        },
        stripe: {
            base: { alignSelf: 'stretch' },
            selectors: {
                '&[data-tone="working"]': { background: 'var(--color-info)' },
                '&[data-tone="live"]': { background: 'var(--color-primary)' },
                '&[data-tone="failed"]': { background: 'var(--color-error)' },
                '&[data-tone="needs-you"]': { background: 'var(--color-warning)' }
            }
        },
        marker: {
            base: { fontWeight: 'var(--weight-bold)', color: 'var(--ag-text-dim)', userSelect: 'none' },
            selectors: {
                '[data-tone="live"] > &': { color: 'var(--color-primary)' },
                '[data-tone="failed"] > &': { color: 'var(--color-error)' },
                // Split: each half carries its own tone.
                '&[data-tone="live"]': { ...tint('var(--color-primary)'), color: 'var(--color-primary)' },
                '&[data-tone="failed"]': { ...tint('var(--color-error)'), color: 'var(--color-error)' }
            }
        },
        text: {
            base: { whiteSpace: 'pre', color: 'var(--color-base-content)' },
            selectors: {
                // In a diff, unchanged lines step back so the change reads first.
                '[data-kind="diff"] [data-context] > &': { color: 'var(--ag-text-muted)' },
                '[data-hunk] > &': { color: 'var(--ag-text-dim)' },
                '[data-mode="split"] &': { overflow: 'hidden', textOverflow: 'clip' },
                '&[data-tone="live"]': tint('var(--color-primary)'),
                '&[data-tone="failed"]': tint('var(--color-error)'),
                '&[data-empty]': { background: 'repeating-linear-gradient(135deg, transparent 0 4px, var(--ag-line) 4px 5px)', alignSelf: 'stretch' }
            }
        },
        widget: {
            // Pinned to the visible width while the rows scroll sideways under it.
            base: { position: 'sticky', insetInlineStart: '0', margin: '6px var(--space-lg) var(--space-sm) 116px', fontFamily: 'var(--font-sans)' },
            selectors: { '[data-kind="viewer"] > &': { marginInlineStart: '71px' }, '[data-mode="split"] > &': { marginInlineStart: '68px' } }
        },
        notice: { base: { margin: '0', padding: 'var(--space-lg) var(--space-xl)', fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)', color: 'var(--ag-text-muted)' } }
    }
};

/** The status letter: 18 px, radius 3, a border in the ink at 33 %, mono 10 / 700. */
const statusTile: RecipeInput = {
    component: 'ag-status-tile',
    tokens: { '--ag-ink': 'var(--ag-text-dim)' },
    parts: {
        root: {
            base: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', inlineSize: '18px', blockSize: '18px', flexShrink: '0', boxSizing: 'border-box', border: 'var(--border) solid color-mix(in oklab, var(--ag-ink) 33%, transparent)', borderRadius: '3px', color: 'var(--ag-ink)', fontFamily: mono, fontSize: '10px', fontWeight: 'var(--weight-bold)', lineHeight: 'var(--leading-none)' }
        }
    },
    variants: {
        tone: {
            working: { root: { base: { '--ag-ink': 'var(--color-info)' } } },
            live: { root: { base: { '--ag-ink': 'var(--color-primary)' } } },
            failed: { root: { base: { '--ag-ink': 'var(--color-error)' } } },
            dim: { root: { base: { '--ag-ink': 'var(--ag-text-dim)' } } }
        }
    },
    defaultVariants: { tone: 'dim' }
};

/** `+n −n`: mono 11 / 600, 6 px apart. */
const diffCounts: RecipeInput = {
    component: 'ag-diff-counts',
    parts: {
        root: { base: { display: 'inline-flex', alignItems: 'center', gap: 'var(--space-xs)', flexShrink: '0', fontFamily: mono, fontSize: 'var(--text-xs)', fontWeight: 'var(--weight-semibold)', whiteSpace: 'nowrap' } },
        added: { base: { color: 'var(--color-primary)' } },
        removed: { base: { color: 'var(--color-error)' } }
    }
};

/** The Changes list column: groups 16 px apart, 40 px file rows, commit rows, the read-only note at the foot. */
const changes: RecipeInput = {
    component: 'ag-changes',
    parts: {
        root: { base: { display: 'flex', flexDirection: 'column', gap: 'var(--space-lg)', minBlockSize: '100%', boxSizing: 'border-box', padding: 'var(--space-lg) var(--space-md)' } },
        group: { base: { display: 'flex', flexDirection: 'column', gap: '4px', minInlineSize: '0' } },
        heading: { base: { display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', padding: '0 10px' } },
        label: { base: { ...label, flex: '1' } },
        aside: { base: { fontFamily: mono, fontSize: 'var(--text-xs)', color: 'var(--ag-text-dim)', whiteSpace: 'nowrap' } },
        item: {
            base: { display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', blockSize: '40px', padding: '0 10px', boxSizing: 'border-box', border: 'var(--border) solid transparent', borderRadius: 'var(--radius-field)', textDecoration: 'none', color: 'var(--color-base-content)', transition: `background ${motion}` },
            selectors: {
                '&:hover': { background: 'var(--color-base-200)' },
                '&:focus-visible': { ...ring, outlineOffset: '-2px' },
                '&[aria-current]': { background: 'var(--color-base-300)', borderColor: 'var(--ag-line-strong)' }
            }
        },
        body: { base: { display: 'flex', flexDirection: 'column', flex: '1', minInlineSize: '0' } },
        name: {
            base: { ...ellipsis, fontFamily: mono, fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-medium)', color: 'var(--color-base-content)' },
            selectors: { '[aria-current] &': { fontWeight: 'var(--weight-semibold)' }, '[data-deleted] &': { textDecoration: 'line-through', color: 'var(--ag-text-muted)' } }
        },
        // Truncated from the start so the last folder stays visible: rtl with `&lrm;` guards in the markup.
        folder: { base: { ...ellipsis, direction: 'rtl', textAlign: 'left', fontFamily: mono, fontSize: '10px', color: 'var(--ag-text-dim)' } },
        commit: { base: { display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', padding: '6px 10px', color: 'var(--ag-text-dim)' }, selectors: { '& > svg': { flexShrink: '0' } } },
        subject: { base: { ...ellipsis, fontFamily: 'var(--font-sans)', fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-medium)', color: 'var(--color-base-content)' } },
        meta: { base: { display: 'flex', flexDirection: 'column', gap: '1px', flex: '1', minInlineSize: '0', fontFamily: mono, fontSize: '10px', color: 'var(--ag-text-dim)' } },
        empty: { base: { margin: '0', padding: '6px 10px', fontSize: 'var(--text-sm)', color: 'var(--ag-text-muted)' } },
        note: { base: { display: 'flex', alignItems: 'flex-start', gap: 'var(--space-sm)', margin: 'auto 0 0', padding: '0 10px', fontSize: 'var(--text-xs)', color: 'var(--ag-text-dim)', textWrap: 'pretty' }, selectors: { '& > svg': { flexShrink: '0', marginBlockStart: '1px' } } }
    }
};

/**
 * The folder tree's row (#587): zero's `TreeView` lays the tree out and
 * indents each folder's group; the row is the handoff's — 28 px, folders in
 * `text`, files in `text-muted`, the selection on `base-300` rather than the
 * design system's accent fill.
 */
const fileTree: RecipeInput = {
    component: 'ag-file-tree',
    parts: {
        item: {
            base: {
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-xs)',
                blockSize: '28px',
                padding: '0 10px',
                borderRadius: 'var(--radius-selector)',
                color: 'var(--color-base-content)',
                cursor: 'pointer',
                outline: 'none',
                userSelect: 'none'
            },
            states: {
                selected: { background: 'var(--color-base-300)', color: 'var(--color-base-content)' },
                'focus-visible': { boxShadow: 'inset 0 0 0 2px var(--color-primary)' }
            },
            selectors: {
                '&[data-type="file"]': { color: 'var(--ag-text-muted)' },
                '&:hover': { background: 'var(--color-base-200)' },
                // The folder chevron is TreeView's indicator (it turns on open); the file row's blank keeps names aligned.
                '& > [data-scope="tree-view"][data-part="branch-indicator"]': { display: 'inline-flex', inlineSize: '12px', flexShrink: '0', color: 'var(--ag-text-dim)', opacity: '1' }
            }
        },
        toggle: { base: { display: 'inline-flex', inlineSize: '12px', flexShrink: '0' } },
        icon: { base: { display: 'inline-flex', flexShrink: '0', color: 'var(--ag-text-dim)' } },
        name: { base: { ...ellipsis, flex: '1', fontFamily: mono, fontSize: 'var(--text-sm)' }, selectors: { '[data-selected] > &': { fontWeight: 'var(--weight-semibold)' } } },
        dot: {
            base: { inlineSize: '6px', blockSize: '6px', borderRadius: '50%', flexShrink: '0', background: 'var(--color-info)' },
            selectors: { '&[data-tone="live"]': { background: 'var(--color-primary)' }, '&[data-tone="failed"]': { background: 'var(--color-error)' }, '&[data-tone="dim"]': { background: 'var(--ag-text-dim)' } }
        },
        status: { base: { margin: '0', padding: '0 10px 0 28px', blockSize: '28px', display: 'flex', alignItems: 'center', fontSize: 'var(--text-xs)', color: 'var(--ag-text-dim)' } },
        legend: {
            base: { display: 'flex', alignItems: 'center', gap: 'var(--space-xs)', padding: '0 10px', fontSize: 'var(--text-xs)', color: 'var(--ag-text-dim)' },
            selectors: { '& > [data-spacer]': { flex: '1' }, '& > [data-mono]': { fontFamily: mono } }
        }
    }
};

/**
 * `Go to file`: 34 px, an outline field with the search icon, zero's
 * `Combobox` (its control flattened into this field, its popup the results
 * list) and a zero `Kbd` hint.
 */
const find: RecipeInput = {
    component: 'ag-find',
    parts: {
        root: {
            base: { position: 'relative', display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', blockSize: '34px', padding: '0 10px', boxSizing: 'border-box', border: 'var(--border) solid var(--ag-line-strong)', borderRadius: 'var(--radius-field)', color: 'var(--ag-text-dim)' },
            selectors: {
                '&:focus-within': { borderColor: 'var(--ag-text-dim)' },
                '& > [data-scope="field"]': { flex: '1', minInlineSize: '0' },
                '& [data-scope="combobox"][data-part="control"]': { blockSize: '32px', minBlockSize: '0', padding: '0', border: 'none', background: 'transparent', boxShadow: 'none' },
                '& [data-scope="combobox"][data-part="input"]': { padding: '0', fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)' },
                '& [data-scope="combobox"][data-part="input"]::-webkit-search-cancel-button': { display: 'none' },
                // No disclosure button: the list is a search's results, opened by typing.
                '& [data-scope="combobox"][data-part="trigger"]': { display: 'none' },
                '& [data-scope="combobox"][data-part="popup"]': { maxBlockSize: '320px', overflow: 'auto' },
                // Paths truncate from the start so the file name stays visible: rtl with `&lrm;` guards in the markup.
                '& [data-scope="combobox"][data-part="item"]': { ...ellipsis, display: 'block', direction: 'rtl', textAlign: 'left', fontFamily: mono, fontSize: 'var(--text-sm)' },
                '& > [data-scope="kbd"]': { flexShrink: '0', fontFamily: mono, fontSize: '10px', fontWeight: 'var(--weight-normal)', color: 'var(--ag-text-dim)', background: 'transparent', borderColor: 'var(--ag-line-strong)', borderBlockEndWidth: 'var(--border)' }
            }
        },
        icon: { base: { display: 'inline-flex', flexShrink: '0' } }
    }
};

/** The session bar: 44 px tabs on `base-200`, 24 px apart, a 2 px `live` underline on the open one. */
const sessionBar: RecipeInput = {
    component: 'ag-session-bar',
    parts: {
        root: { base: { display: 'flex', alignItems: 'center', gap: 'var(--space-2xl)', flexShrink: '0', padding: '0 var(--space-2xl)', minInlineSize: '0', borderBlockEnd: 'var(--border) solid var(--ag-line)', background: 'var(--color-base-200)' } },
        tabs: { base: { display: 'flex', gap: 'var(--space-2xl)', flexShrink: '0' } },
        tab: {
            base: { display: 'inline-flex', alignItems: 'center', blockSize: '44px', padding: '0 2px', boxSizing: 'border-box', borderBlockEnd: '2px solid transparent', fontSize: 'var(--text-md)', fontWeight: 'var(--weight-medium)', color: 'var(--ag-text-muted)', textDecoration: 'none', whiteSpace: 'nowrap' },
            selectors: {
                '&:hover': { color: 'var(--color-base-content)' },
                '&:focus-visible': { ...ring, outlineOffset: '-2px' },
                '&[aria-current="page"]': { color: 'var(--color-base-content)', fontWeight: 'var(--weight-semibold)', borderBlockEndColor: 'var(--color-primary)' }
            }
        },
        count: { base: { marginInlineStart: 'var(--space-xs)', fontFamily: mono, fontSize: 'var(--text-xs)', fontWeight: 'var(--weight-normal)', color: 'var(--ag-text-dim)' } },
        divider: { base: { inlineSize: '1px', blockSize: '20px', flexShrink: '0', background: 'var(--ag-line-strong)' } },
        context: { base: { display: 'flex', alignItems: 'center', gap: '10px', minInlineSize: '0', flex: '1' } },
        env: { base: { ...ellipsis, fontFamily: mono, fontSize: 'var(--text-sm)', color: 'var(--ag-text-muted)' } },
        branch: {
            base: { display: 'inline-flex', alignItems: 'center', gap: 'var(--space-xs)', blockSize: '24px', padding: '0 var(--space-sm)', minInlineSize: '0', boxSizing: 'border-box', border: 'var(--border) solid var(--ag-line-strong)', borderRadius: 'var(--radius-selector)', fontFamily: mono, fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-medium)', color: 'var(--color-base-content)', whiteSpace: 'nowrap' },
            selectors: { '& > svg': { color: 'var(--ag-text-dim)' }, '& > span': ellipsis }
        },
        ahead: { base: { fontFamily: mono, fontSize: 'var(--text-xs)', color: 'var(--ag-text-dim)', whiteSpace: 'nowrap' } },
        controls: {
            base: { display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', flexShrink: '0', marginInlineStart: 'auto' },
            selectors: { '& [data-intent="icon"]': { inlineSize: '32px', blockSize: '32px', minBlockSize: '32px', background: 'transparent', color: 'var(--ag-text-muted)' } }
        }
    }
};

/** A file's header: 14 × 20 px padding, mono 13 path, actions right. */
const fileHeader: RecipeInput = {
    component: 'ag-file-header',
    parts: {
        // Wraps: a page's actions ("Edited by", Open diff, Mention in chat) drop under the path rather than scroll the page.
        root: { base: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-sm) var(--space-md)', padding: '14px var(--space-xl)', minInlineSize: '0', borderBlockEnd: 'var(--border) solid var(--ag-line)' } },
        path: { base: { ...ellipsis, fontFamily: mono, fontSize: 'var(--text-md)', color: 'var(--ag-text-muted)' } },
        name: { base: { color: 'var(--color-base-content)', fontWeight: 'var(--weight-semibold)' } },
        sep: { base: { color: 'var(--ag-text-muted)' } },
        facts: { base: { display: 'inline-flex', alignItems: 'center', gap: 'var(--space-xs)', flexShrink: '0', fontFamily: mono, fontSize: 'var(--text-xs)', color: 'var(--ag-text-dim)', whiteSpace: 'nowrap' } },
        actions: {
            base: { display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center', gap: 'var(--space-sm)', minInlineSize: '0', marginInlineStart: 'auto' },
            selectors: {
                '& [data-scope="button"]': { minBlockSize: '32px', blockSize: '32px' },
                '& [data-intent="icon"]': { inlineSize: '32px', background: 'transparent', color: 'var(--ag-text-muted)' },
                '& a': { fontSize: 'var(--text-sm)' }
            }
        }
    }
};

/** The ask-about-a-line composer: base-200 card, radius 8, 12 px padding, 10 px rhythm. */
const lineComposer: RecipeInput = {
    component: 'ag-line-composer',
    parts: {
        root: { base: { display: 'flex', flexDirection: 'column', gap: '10px', margin: '0', padding: 'var(--space-md)', border: 'var(--border) solid var(--ag-line-strong)', borderRadius: 'var(--radius-box)', background: 'var(--color-base-200)', color: 'var(--color-base-content)', fontFamily: 'var(--font-sans)' } },
        head: { base: { display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', minInlineSize: '0' } },
        title: { base: { ...ellipsis, flex: '1', fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-semibold)' } },
        ref: { base: { fontFamily: mono, fontSize: 'var(--text-xs)', color: 'var(--ag-text-dim)', whiteSpace: 'nowrap' } },
        // zero's Textarea wears the design system's field chrome; here it fills the row (autosizing from two rows).
        input: {
            base: { display: 'block' },
            selectors: {
                '& [data-scope="textarea"][data-part="textarea"]': { inlineSize: '100%', boxSizing: 'border-box', padding: '10px', fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)' }
            }
        },
        foot: {
            base: { display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', flexWrap: 'wrap' },
            selectors: { '& [data-scope="button"]': { minBlockSize: '32px', blockSize: '32px' } }
        },
        note: { base: { flex: '1 1 12rem', minInlineSize: '0', fontSize: 'var(--text-xs)', color: 'var(--ag-text-dim)' } }
    }
};

export const codeRecipes: RecipeInput[] = [code, statusTile, diffCounts, changes, fileTree, find, sessionBar, fileHeader, lineComposer];
