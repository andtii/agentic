import type { RecipePatch } from '@sigx/zero-kit/define';
import { fieldBase, fieldStates } from './shared.js';

// The shared field chrome (`fieldBase` / `fieldStates`), as on `input`.
const patch: RecipePatch = {
    parts: {
        control: { base: fieldBase, states: { ...fieldStates, open: { borderColor: 'var(--color-primary)' } } },
        input: { base: { fontSize: 'var(--text-md)', fontWeight: 'var(--weight-normal)', padding: '0 var(--space-md)' }, selectors: { '&::placeholder': { color: 'var(--ag-text-dim)' } } },
        popup: { base: { background: 'var(--color-base-300)', borderColor: 'var(--ag-line-strong)', boxShadow: 'var(--shadow-xl)', padding: 'var(--space-xs)' } },
        item: { base: { padding: 'var(--space-sm) var(--space-md)', fontSize: 'var(--text-md)', fontWeight: 'var(--weight-normal)' }, states: { highlighted: { background: 'var(--color-base-100)' } } }
    }
};

export default patch;
