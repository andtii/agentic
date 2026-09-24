import type { RecipePatch } from '@sigx/zero-kit/define';
import { mono } from './shared.js';

/** The roles daisy colours a marker in; each is re-inked below. */
const ROLES = ['primary', 'secondary', 'accent', 'neutral', 'info', 'success', 'warning', 'error'] as const;
/** A role's ink — `neutral` is the muted text, not daisy's base-300 fill. */
const ink = (role: string): string => (role === 'neutral' ? 'var(--ag-text-muted)' : `var(--color-${role})`);

// Timeline: an 8 px dot in the state colour (a plain dot — the ring is the
// fill), 1 px `line-strong` connector, plain text content 13 with the time
// (`data-timeline-time`) in mono 11 text-dim. Both greys are `neutral`: the muted ink.
const patch: RecipePatch = {
    tokens: { '--timeline-marker-size': 'var(--space-sm)', '--timeline-accent': 'var(--ag-text-muted)' },
    parts: {
        connector: { base: { background: 'var(--ag-line-strong)' } },
        content: {
            base: { border: 'none', background: 'transparent', padding: '0', margin: '0 var(--space-md) var(--space-md)', fontSize: 'var(--text-md)' },
            selectors: { '& [data-timeline-time]': { fontFamily: mono, fontSize: 'var(--text-xs)', color: 'var(--ag-text-dim)' } }
        }
    },
    variants: {
        color: Object.fromEntries(ROLES.map((role) => [role, { marker: { base: { '--timeline-accent': ink(role), '--timeline-ring': ink(role) } } }]))
    }
};

export default patch;
