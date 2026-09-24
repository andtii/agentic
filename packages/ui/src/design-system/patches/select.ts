import type { RecipePatch } from '@sigx/zero-kit/define';
import { fieldBase, fieldStates } from './shared.js';

// The shared field chrome (`fieldBase` / `fieldStates`), as on `input`. `xs` is the 24 px select inside a
// chip (the agent form's per-tool mode), a pill's height rather than daisy's 32 px.
const patch: RecipePatch = {
    variants: { size: { xs: { trigger: { base: { height: '24px', paddingBlock: '0' } } } } },
    parts: {
        trigger: {
            base: { ...fieldBase, paddingInline: 'var(--space-md)', fontWeight: 'var(--weight-normal)' },
            states: { ...fieldStates, open: { borderColor: 'var(--color-primary)' } }
        },
        popup: { base: { background: 'var(--color-base-300)', borderColor: 'var(--ag-line-strong)', boxShadow: 'var(--shadow-xl)', padding: 'var(--space-xs)' } },
        item: { base: { padding: 'var(--space-sm) var(--space-md)', fontSize: 'var(--text-md)', fontWeight: 'var(--weight-normal)' }, states: { highlighted: { background: 'var(--color-base-100)' } } }
    }
};

export default patch;
