import type { RecipePatch } from '@sigx/zero-kit/define';
import { ring } from './shared.js';

// Collapsible: the borderless disclosure the thread folds on — a reasoning
// block ("Reasoning · 6s"), a tool call's input and output, a sub-agent's work.
// daisy's `::after` chevron moves in front of the label (`order: -1`) and
// points right while closed, down while open; the label is `text-dim`, and
// `text-muted` once open (the accent the open trigger takes).
const patch: RecipePatch = {
    parts: {
        root: { base: { border: 'none', borderRadius: '0', background: 'transparent', overflow: 'visible', '--collapsible-accent': 'var(--ag-text-muted)' } },
        trigger: {
            base: { padding: 'var(--space-2xs) 0', fontSize: 'var(--text-md)', fontWeight: 'var(--weight-normal)', color: 'var(--ag-text-dim)', justifyContent: 'flex-start', gap: 'var(--space-sm)', cursor: 'pointer', listStyle: 'none' },
            states: { hover: { background: 'transparent', color: 'var(--color-base-content)' }, 'focus-visible': ring },
            selectors: {
                '&::-webkit-details-marker': { display: 'none' },
                '&::after': { order: '-1', flexShrink: '0', width: '0.4rem', height: '0.4rem', marginInline: 'var(--space-2xs)', opacity: '1', transform: 'rotate(-45deg)' },
                '&[data-state="open"]::after': { transform: 'rotate(45deg)' }
            }
        },
        panel: { base: { padding: 'var(--space-xs) 0 0', fontSize: 'var(--text-md)' } }
    }
};

export default patch;
