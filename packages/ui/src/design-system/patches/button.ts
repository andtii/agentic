import type { RecipePatch } from '@sigx/zero-kit/define';
import { motion, ring } from './shared.js';

// Button: 36 px, radius 6, 13 / 600, no shadow. Hover/pressed stay daisy's
// brightness steps; the ring is the 2 px primary ring; disabled is the 40 %
// token. `neutral solid` is the handoff's DEFAULT button: base-300 fill,
// `line-strong` border, hover border `text-dim`.
const patch: RecipePatch = {
    parts: {
        // The loading spinner is zero's `spinner` part (0.3; it was daisy's `loading` modifier).
        spinner: { base: { inlineSize: '14px', blockSize: '14px' } },
        root: {
            base: {
                height: 'var(--ag-control-h)',
                gap: 'var(--space-sm)',
                boxShadow: 'none',
                fontSize: 'var(--text-md)',
                transition: `background ${motion}, border-color ${motion}, filter ${motion}`,
                // A label never wraps: the button grows, the row wraps.
                whiteSpace: 'nowrap'
            },
            states: { 'focus-visible': ring },
            selectors: { '& > span': { whiteSpace: 'nowrap' } },
            // Phones: the 48 px touch height; an icon button stays square.
            at: {
                'below-md': {
                    base: { minBlockSize: 'var(--ag-control-h-touch)' },
                    selectors: { '&[data-intent="icon"]': { minInlineSize: 'var(--ag-control-h-touch)' } }
                }
            }
        }
    },
    variants: {
        size: { md: { root: { base: { padding: '0 var(--space-lg)', fontSize: 'var(--text-md)' } } } }
    },
    compoundVariants: [
        {
            match: { color: 'neutral', variant: 'solid' },
            parts: {
                root: {
                    base: { borderColor: 'var(--ag-line-strong)' },
                    states: { hover: { filter: 'none', borderColor: 'var(--ag-text-dim)' } }
                }
            }
        }
    ]
};

export default patch;
