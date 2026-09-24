import type { RecipePatch } from '@sigx/zero-kit/define';

// Toggle group: the segmented control — a 2 px inset track on base-100, 30 px segments, selected = base-300.
const patch: RecipePatch = {
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
};

export default patch;
