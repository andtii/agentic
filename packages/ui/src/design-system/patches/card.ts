import type { RecipePatch } from '@sigx/zero-kit/define';

// Card: base-200 with a `line` border, radius 8, padding 20, no shadow.
const patch: RecipePatch = {
    tokens: { '--card-pad': 'var(--space-xl)' },
    parts: {
        root: { base: { background: 'var(--color-base-200)', border: 'var(--border) solid var(--ag-line)', boxShadow: 'none' } },
        title: { base: { fontSize: 'var(--text-xl)' } },
        description: { base: { color: 'var(--ag-text-muted)', fontSize: 'var(--text-md)' } },
        body: { base: { fontSize: 'var(--text-md)' } }
    }
};

export default patch;
