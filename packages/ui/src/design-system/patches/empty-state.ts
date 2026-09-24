import type { RecipePatch } from '@sigx/zero-kit/define';
import { mono } from './shared.js';

/** The roles daisy tints an empty state in; each is re-inked below. */
const ROLES = ['primary', 'secondary', 'accent', 'neutral', 'info', 'success', 'warning', 'error'] as const;
/** A role's ink — `neutral` is the muted text, not daisy's base-300 fill. */
const ink = (role: string): string => (role === 'neutral' ? 'var(--ag-text-muted)' : `var(--color-${role})`);

/** The six named failure states (`FailureCard`'s `kind`): muted for the browser, amber where a person can act on the machine, red where work stopped. */
const KIND_INK = {
    offline: 'var(--ag-text-muted)',
    machine: 'var(--color-warning)',
    auth: 'var(--color-warning)',
    runtime: 'var(--color-error)',
    task: 'var(--color-error)',
    interrupted: 'var(--color-error)'
} as const;

// Empty state: the handoff's empty screens and failure cards, one anatomy.
// A start-aligned card on base-200 with the `line` border and the box radius,
// title 16 / 600, the description 13 in text-muted, the actions under it
// (full width, split evenly, below md). `compact` is the one muted line with
// no chrome, `outline` the dashed card.
//
// Coloured (a `FailureCard`): the border is the ink at 33 %, and the title
// row is the failure's header — the 16 px icon and the name 14 / 600 in the
// ink, the mono signal caption pushed to the end.
const patch: RecipePatch = {
    tokens: { '--empty-accent': 'var(--ag-text-muted)', '--empty-tint': 'var(--color-base-200)' },
    parts: {
        root: {
            base: {
                alignItems: 'flex-start',
                textAlign: 'start',
                gap: 'var(--space-sm)',
                padding: 'var(--space-xl)',
                border: 'var(--border) solid var(--ag-line)',
                minInlineSize: '0'
            }
        },
        icon: { base: { fontSize: 'inherit', marginBlockEnd: '0' } },
        title: {
            base: { fontSize: 'var(--text-xl)', fontWeight: 'var(--weight-semibold)' },
            selectors: {
                '&:has([data-failure-name])': { display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', alignSelf: 'stretch', minInlineSize: '0', fontSize: 'var(--text-lg)', color: 'var(--empty-accent)' },
                '& [data-failure-icon]': { display: 'inline-flex', flexShrink: '0' },
                '& [data-failure-name]': { flex: '1 1 auto', minInlineSize: '0' },
                '& [data-failure-signal]': { marginInlineStart: 'auto', fontFamily: mono, fontSize: 'var(--text-xs)', fontWeight: 'var(--weight-normal)', color: 'var(--ag-text-dim)', whiteSpace: 'nowrap' }
            }
        },
        description: { base: { maxInlineSize: 'none', margin: '0', fontSize: 'var(--text-md)', color: 'var(--ag-text-muted)', textWrap: 'pretty' } },
        actions: {
            base: { justifyContent: 'flex-start', marginBlockStart: 'var(--space-xs)' },
            at: { 'below-md': { selectors: { '& > *': { flex: '1 1 0' } } } }
        }
    },
    variants: {
        color: Object.fromEntries(ROLES.map((role) => [role, { root: { base: {
            '--empty-accent': ink(role),
            '--empty-tint': 'var(--color-base-200)',
            borderColor: `color-mix(in oklab, ${ink(role)} 33%, transparent)`
        } } }])),
        kind: Object.fromEntries(Object.entries(KIND_INK).map(([kind, color]) => [kind, { root: { base: { '--empty-accent': color } } }]))
    },
    modifiers: {
        compact: { root: { base: { padding: '0', border: 'none', background: 'transparent' } } },
        outline: { root: { base: { borderStyle: 'dashed', borderColor: 'var(--ag-line-strong)', background: 'transparent' } } }
    }
};

export default patch;
