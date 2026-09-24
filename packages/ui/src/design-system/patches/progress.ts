import type { RecipePatch } from '@sigx/zero-kit/define';
import { motion } from './shared.js';

/** The roles daisy colours a bar in; each is re-inked below. */
const ROLES = ['primary', 'secondary', 'accent', 'neutral', 'info', 'success', 'warning', 'error'] as const;
/** A role's ink — `neutral` is the dim text (a limit with no number), not daisy's base-300 fill. */
const ink = (role: string): string => (role === 'neutral' ? 'var(--ag-text-dim)' : `var(--color-${role})`);

// Progress: the quota bar (`QuotaMeter`). An 8 px track in `line-strong`
// with the selector radius (6 px at `sm`, the compact meter), the range in
// the role's own ink — a full bar keeps its colour: an exhausted limit is
// red, not daisy's success green.
const patch: RecipePatch = {
    parts: {
        root: { base: { gap: '0', minInlineSize: '0' } },
        track: { base: { height: '8px', background: 'var(--ag-line-strong)', borderRadius: 'var(--radius-selector)' } },
        range: {
            base: { borderRadius: 'inherit', transition: `width ${motion}` },
            states: { complete: { background: null } }
        }
    },
    variants: {
        color: Object.fromEntries(ROLES.map((role) => [role, { range: { base: { background: ink(role) } } }])),
        size: { sm: { track: { base: { height: '6px' } } } }
    },
    // A full bar is the same bar, only longer: the colour is the status, not "done".
    sameAs: { root: { complete: 'loading' }, range: { complete: 'loading' } }
};

export default patch;
