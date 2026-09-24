import type { RecipePatch } from '@sigx/zero-kit/define';
import { mono } from './shared.js';

/** The roles daisy colours a badge in; each is re-inked below. */
const ROLES = ['primary', 'secondary', 'accent', 'neutral', 'info', 'success', 'warning', 'error'] as const;

/** A role's ink — `neutral` is the muted text, not daisy's base-300 fill. */
const ink = (role: string): string => (role === 'neutral' ? 'var(--ag-text-muted)' : `var(--color-${role})`);

// Badge: the control-room pill every `StatusPill` and `Tag` is. 22 px, mono
// 11 / 500, radius-selector; the colour is the ink, the fill the ink at 8 %
// and the border at 33 % (`soft`). A 6 px dot in the ink; `outline` (a hollow
// pill, a tag) drops the fill for the `line-strong` border and draws the dot
// as a ring. A pill (`data-status`) says its word in capitals, a tag
// (`data-tag`) as written. Both greys (`muted`, `dim`) are `neutral`: the muted ink.
const patch: RecipePatch = {
    tokens: { '--badge-fill': 'transparent', '--badge-ink': 'var(--ag-text-muted)' },
    parts: {
        root: {
            base: {
                gap: 'var(--space-xs)',
                height: 'var(--ag-pill-h)',
                padding: '0 var(--space-sm)',
                boxSizing: 'border-box',
                borderColor: 'var(--ag-line-strong)',
                fontFamily: mono,
                fontSize: 'var(--text-xs)',
                fontWeight: 'var(--weight-medium)',
                letterSpacing: 'var(--tracking-wide)',
                lineHeight: 'var(--leading-none)',
                flexShrink: '0'
            },
            selectors: {
                '&[data-status]': { textTransform: 'uppercase' },
                '&[data-tag]': { letterSpacing: 'var(--tracking-normal)' }
            }
        },
        dot: { base: { inlineSize: '6px', blockSize: '6px', borderWidth: '0' } }
    },
    variants: {
        color: Object.fromEntries(ROLES.map((role) => [role, {
            root: { base: { '--badge-ink': ink(role), '--badge-fill': `color-mix(in oklab, ${ink(role)} 8%, transparent)` } },
            dot: { base: { '--badge-dot': ink(role), '--badge-dot-ring': ink(role) } }
        }])),
        variant: {
            soft: { root: { base: { borderColor: 'color-mix(in oklab, var(--badge-ink) 33%, transparent)' } } },
            outline: {
                root: { base: { background: 'transparent', borderColor: 'var(--ag-line-strong)' } },
                dot: { base: { background: 'transparent', borderWidth: '1.5px' } }
            }
        }
    }
};

export default patch;
