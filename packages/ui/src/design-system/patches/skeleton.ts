import type { RecipePatch } from '@sigx/zero-kit/define';

// Skeleton: 14 px bars in `line`.
const patch: RecipePatch = {
    tokens: { '--skeleton-fill': 'var(--ag-line)' },
    parts: { root: { base: { borderRadius: 'var(--radius-selector)', minBlockSize: '14px' } } }
};

export default patch;
