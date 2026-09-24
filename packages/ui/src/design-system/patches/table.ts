import type { RecipePatch } from '@sigx/zero-kit/define';
import { label } from './shared.js';

/** Table row hover: base-300 at 50 %. */
const rowHover = 'color-mix(in oklab, var(--color-base-300) 50%, transparent)';

// Table: base-200 box with `line` borders; head 10 / 16 in the mono label voice, body 14 / 16, hover base-300 at 50 %.
const patch: RecipePatch = {
    tokens: { '--table-pad-block': '14px', '--table-pad-inline': 'var(--space-lg)', '--table-font': 'var(--text-lg)' },
    parts: {
        root: { base: { border: 'var(--border) solid var(--ag-line)', background: 'var(--color-base-200)' } },
        row: { base: { borderBlockEnd: 'var(--border) solid var(--ag-line)' } },
        'header-cell': { base: { ...label, padding: '10px var(--table-pad-inline)' } },
        caption: { base: { ...label, padding: 'var(--space-md) var(--table-pad-inline)' } }
    },
    modifiers: {
        hover: { row: { selectors: { '[data-scope="table"][data-part="body"] > &:hover:not([data-selected])': { background: rowHover } } } }
    }
};

export default patch;
