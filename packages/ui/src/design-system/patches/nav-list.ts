import type { RecipePatch } from '@sigx/zero-kit/define';
import { label, motion } from './shared.js';

/**
 * NavList: the shell's navigation (`docs/design/HANDOFF.md` → "Layout and
 * shell"). Groups 24 apart, headings in the mono label voice, 38 px items at
 * 14 / 500 in `text-muted`; the current item is base-300, semibold, with the
 * 3 × 16 px live marker at its start edge. In the phone sheet the items are
 * 50 px at 16 px with 20 px glyphs ("Mobile specifics"). The count in `meta`
 * is a Badge, so the part keeps full ink.
 */
const inSheet = '[data-scope="drawer"][data-part="panel"][data-l-dock="sheet"]';

const patch: RecipePatch = {
    tokens: {
        '--nav-ink': 'var(--ag-text-muted)',
        '--nav-tint': 'var(--color-base-300)',
        '--nav-accent': 'var(--color-base-content)'
    },
    parts: {
        root: { base: { gap: 'var(--space-2xl)', fontSize: 'var(--text-lg)' } },
        heading: { base: { ...label, padding: '0 var(--space-md) var(--space-xs)', opacity: '1' } },
        link: {
            base: {
                position: 'relative',
                gap: 'calc(var(--space-sm) + var(--space-2xs))',
                blockSize: '38px',
                padding: '0 var(--space-md)',
                transition: `background ${motion}, color ${motion}`
            },
            states: {
                hover: { color: 'var(--color-base-content)' },
                active: { fontWeight: 'var(--weight-semibold)' },
                'focus-visible': { outline: '2px solid var(--color-primary)', outlineOffset: '-2px' }
            },
            selectors: {
                '&[data-state="active"]::before': {
                    content: '""',
                    position: 'absolute',
                    insetInlineStart: '0',
                    insetBlockStart: '50%',
                    inlineSize: '3px',
                    blockSize: '16px',
                    translate: '0 -50%',
                    borderRadius: '0 var(--radius-selector) var(--radius-selector) 0',
                    background: 'var(--color-primary)'
                },
                [`${inSheet} &`]: { blockSize: '50px', fontSize: '16px' }
            }
        },
        icon: {
            base: { inlineSize: 'auto' },
            selectors: { [`${inSheet} & > svg`]: { inlineSize: '20px', blockSize: '20px' } }
        },
        meta: { base: { opacity: '1' } }
    }
};

export default patch;
