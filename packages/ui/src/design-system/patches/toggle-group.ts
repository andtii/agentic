import type { RecipePatch } from '@sigx/zero-kit/define';
import { mono, ring } from './shared.js';

/** A `FilterChips` bar: the root carries `data-filter-chips`. */
const CHIPS = '[data-filter-chips]';

// Toggle group: the segmented control — a 2 px inset track on base-100, 30 px segments, selected = base-300.
// A filter bar (`FilterChips`, `data-filter-chips`) is a wrapping row of separate chips instead: 22 px mono
// pills with the `line-strong` outline, pressed = the primary at 15 % with a primary border, the count dim.
const patch: RecipePatch = {
    tokens: { '--toggle-group-accent': 'var(--color-base-300)', '--toggle-group-on-accent': 'var(--color-base-content)' },
    parts: {
        root: {
            base: { background: 'var(--color-base-100)', border: 'var(--border) solid var(--ag-line-strong)', padding: 'var(--space-2xs)', gap: 'var(--space-2xs)', boxShadow: 'none' },
            selectors: { [`&${CHIPS}`]: { flexWrap: 'wrap', gap: 'var(--space-sm)', padding: '0', border: 'none', borderRadius: '0', background: 'transparent', overflow: 'visible' } }
        },
        item: {
            base: { height: '30px', padding: '0 var(--space-md)', fontSize: 'var(--text-md)', borderRadius: 'var(--radius-selector)', color: 'var(--ag-text-muted)' },
            states: { hover: { background: 'transparent', color: 'var(--color-base-content)' }, 'focus-visible': { outline: '2px solid var(--color-primary)', outlineOffset: '-2px' } },
            selectors: {
                '&[data-state="on"]:hover': { filter: 'none' },
                '&[data-orientation="horizontal"] + &': { borderInlineStart: '0' },
                '&[data-orientation="vertical"] + &': { borderBlockStart: '0' },
                [`${CHIPS} > &`]: {
                    gap: 'var(--space-xs)',
                    height: 'var(--ag-pill-h)',
                    padding: '0 var(--space-sm)',
                    border: 'var(--border) solid var(--ag-line-strong)',
                    borderRadius: 'var(--radius-selector)',
                    fontFamily: mono,
                    fontSize: 'var(--text-xs)',
                    fontWeight: 'var(--weight-medium)',
                    letterSpacing: 'var(--tracking-wide)'
                },
                [`${CHIPS} > & + &`]: { borderInlineStart: 'var(--border) solid var(--ag-line-strong)', borderBlockStart: 'var(--border) solid var(--ag-line-strong)' },
                [`${CHIPS} > &[data-state="on"]`]: { background: 'color-mix(in oklab, var(--color-primary) 15%, transparent)', borderColor: 'var(--color-primary)', color: 'var(--color-base-content)' },
                [`${CHIPS} > &[data-focus-visible]`]: ring,
                [`${CHIPS} > & [data-chip-count]`]: { color: 'var(--ag-text-dim)' }
            }
        }
    },
    defaultVariants: { color: 'neutral' }
};

export default patch;
