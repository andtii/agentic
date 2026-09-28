import type { RecipePatch } from '@sigx/zero-kit/define';
import { fieldBase, fieldStates } from './shared.js';

// The shared field chrome (`fieldBase` / `fieldStates`), as on `input` — except
// the height is a floor: under `multiple` the tags wrap onto new rows, and a
// fixed height spills them over the next field (#983, signalxjs/zero#407).
const patch: RecipePatch = {
    parts: {
        control: { base: { ...fieldBase, height: 'auto', minHeight: 'var(--ag-input-h)' }, states: { ...fieldStates, open: { borderColor: 'var(--color-primary)' } } },
        input: { base: { fontSize: 'var(--text-md)', fontWeight: 'var(--weight-normal)', padding: '0 var(--space-md)' }, selectors: { '&::placeholder': { color: 'var(--ag-text-dim)' } } },
        popup: { base: { background: 'var(--color-base-300)', borderColor: 'var(--ag-line-strong)', boxShadow: 'var(--shadow-xl)', padding: 'var(--space-xs)' } },
        item: { base: { padding: 'var(--space-sm) var(--space-md)', fontSize: 'var(--text-md)', fontWeight: 'var(--weight-normal)' }, states: { highlighted: { background: 'var(--color-base-100)' } } }
    }
};

export default patch;
