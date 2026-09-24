import type { RecipePatch } from '@sigx/zero-kit/define';
import { fieldBase, fieldStates } from './shared.js';

// Text controls: one field chrome (`fieldBase` / `fieldStates`) for input, textarea, select and combobox.
const patch: RecipePatch = {
    parts: {
        control: { base: fieldBase, states: fieldStates },
        input: { base: { fontSize: 'var(--text-md)', padding: '0 var(--space-md)' }, selectors: { '&::placeholder': { color: 'var(--ag-text-dim)' } } }
    }
};

export default patch;
