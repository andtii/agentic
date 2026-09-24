import type { RecipePatch } from '@sigx/zero-kit/define';
import { fieldBase, fieldStates } from './shared.js';

// The shared field chrome (`fieldBase` / `fieldStates`), as on `input`.
const patch: RecipePatch = {
    parts: {
        textarea: {
            base: { ...fieldBase, height: 'auto', minHeight: 'calc(var(--ag-input-h) * 2)', padding: 'var(--space-sm) var(--space-md)' },
            states: fieldStates,
            selectors: { '&::placeholder': { color: 'var(--ag-text-dim)' } }
        }
    }
};

export default patch;
