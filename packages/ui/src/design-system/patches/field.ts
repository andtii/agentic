import type { RecipePatch } from '@sigx/zero-kit/define';

// Field: label 12 / 600 muted above, hint 12 dim below, error 12 in `failed`.
const patch: RecipePatch = {
    parts: {
        root: { base: { gap: 'var(--space-xs)' } },
        label: { base: { fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-semibold)', color: 'var(--ag-text-muted)' } },
        description: { base: { fontSize: 'var(--text-sm)', color: 'var(--ag-text-dim)', opacity: '1' } },
        error: { base: { fontSize: 'var(--text-sm)', color: 'var(--color-error)', fontWeight: 'var(--weight-normal)' } }
    }
};

export default patch;
