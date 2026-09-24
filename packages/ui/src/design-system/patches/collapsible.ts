import type { RecipePatch } from '@sigx/zero-kit/define';
import { ring } from './shared.js';

// Collapsible: the borderless disclosure a reasoning block folds on — chevron + "Reasoning · 6s" in `text-dim`.
const patch: RecipePatch = {
    parts: {
        root: { base: { border: 'none', borderRadius: '0', background: 'transparent' } },
        trigger: {
            base: { padding: 'var(--space-2xs) 0', fontSize: 'var(--text-md)', fontWeight: 'var(--weight-normal)', color: 'var(--ag-text-dim)', justifyContent: 'flex-start', gap: 'var(--space-sm)' },
            states: { hover: { background: 'transparent', color: 'var(--color-base-content)' }, 'focus-visible': ring },
            selectors: { '&::after': { width: '0.35rem', height: '0.35rem', opacity: '1' } }
        },
        panel: { base: { padding: 'var(--space-sm) 0 0', fontSize: 'var(--text-md)' } }
    }
};

export default patch;
