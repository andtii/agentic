import { tableStackAt, type RecipePatch } from '@sigx/zero-kit/define';
import { tokens } from '../tokens.js';
import { label } from './shared.js';

/** Table row hover: base-300 at 50 %. */
const rowHover = 'color-mix(in oklab, var(--color-base-300) 50%, transparent)';

// Table: base-200 box with `line` borders; head 10 / 16 in the mono label voice, body 14 / 16, hover base-300 at 50 %.
// Stacked (`Table.Root stack`, below its breakpoint): one base-200 card per row on the handoff's xl radius, each
// value captioned in an 88 px mono label column — zero lays the cards out, this is only their chrome.
const patch: RecipePatch = {
    tokens: {
        '--table-pad-block': '14px',
        '--table-pad-inline': 'var(--space-lg)',
        '--table-font': 'var(--text-lg)',
        '--table-stack-label-size': '88px',
        '--table-stack-label-gap': 'var(--space-md)'
    },
    parts: {
        // Positioned: visually hidden head text is absolutely placed and must stay inside the scroll box.
        root: { base: { position: 'relative', minInlineSize: '0', border: 'var(--border) solid var(--ag-line)', background: 'var(--color-base-200)' } },
        // 768–1279: the drawn column widths yield, and a table wider than its column scrolls inside it (the root), never the page.
        column: { at: { 'below-xl': { base: { width: 'auto' } } } },
        row: {
            base: { borderBlockEnd: 'var(--border) solid var(--ag-line)' },
            at: tableStackAt(tokens, 'row', {
                padding: 'var(--space-md) var(--space-lg)',
                border: 'var(--border) solid var(--ag-line)',
                borderRadius: 'var(--ag-radius-xl, var(--radius-box))',
                background: 'var(--color-base-200)'
            })
        },
        'header-cell': { base: { ...label, padding: 'calc(var(--space-sm) + var(--space-2xs)) var(--table-pad-inline)' } },
        cell: { at: tableStackAt(tokens, 'cell', { paddingBlock: 'var(--space-2xs)' }) },
        // Hangs level with the value's first line.
        'cell-label': { base: { ...label, paddingBlockStart: 'var(--space-2xs)' } },
        caption: { base: { ...label, padding: 'var(--space-md) var(--table-pad-inline)' } }
    },
    modifiers: {
        hover: { row: { selectors: { '[data-scope="table"][data-part="body"] > &:hover:not([data-selected])': { background: rowHover } } } }
    }
};

export default patch;
