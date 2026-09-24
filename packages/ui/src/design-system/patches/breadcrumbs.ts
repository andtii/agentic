import type { RecipePatch } from '@sigx/zero-kit/define';
import { ring } from './shared.js';

// Breadcrumbs: 15 / 600 current, 500 parent in `text-muted`, `text-dim` chevrons.
const patch: RecipePatch = {
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
};

export default patch;
