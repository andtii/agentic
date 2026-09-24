import type { RecipePatch } from '@sigx/zero-kit/define';
import { ring } from './shared.js';

/**
 * Drawer: the app shell's sidebar (`docs/design/HANDOFF.md` → "Layout and
 * shell", "Mobile specifics"). The responsive drawer (`modal={{ below }}`,
 * `data-l-dock-above`) is the one the shell renders: a base-200 column,
 * 232 px docked from md up (`data-l-dock="inline"`) and a 312 px sheet on a
 * near-black scrim below (`data-l-dock="sheet"`, daisy's slide). A plain
 * modal drawer (the chat's context panel) keeps daisy's paper. The sticky
 * 100dvh column lives in `shell.css`: `position` is the kit's structure
 * layer's while docked. Trigger and close are the shell's 44 px icon
 * buttons, the only ones the app renders.
 */
const sidebar = '&[data-l-dock-above]';
const iconButton = {
    inlineSize: 'var(--ag-touch-min)',
    blockSize: 'var(--ag-touch-min)',
    height: 'var(--ag-touch-min)',
    padding: '0',
    border: '0',
    background: 'transparent',
    boxShadow: 'none'
};
const iconButtonStates = {
    hover: { background: 'var(--color-base-300)' },
    'focus-visible': ring
};

const patch: RecipePatch = {
    parts: {
        trigger: { base: iconButton, states: iconButtonStates },
        close: { base: iconButton, states: iconButtonStates },
        panel: {
            selectors: {
                [sidebar]: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 'var(--space-2xl)',
                    background: 'var(--color-base-200)',
                    borderRadius: '0',
                    boxShadow: 'none'
                },
                [`${sidebar}[data-l-dock="inline"]`]: {
                    maxInlineSize: 'var(--ag-sidebar-w)',
                    padding: 'var(--space-xl) calc(var(--space-md) + var(--space-2xs))',
                    borderInlineEnd: 'var(--border) solid var(--ag-line)'
                },
                [`${sidebar}[data-l-dock="sheet"]`]: {
                    maxInlineSize: 'min(312px, 90vw)',
                    padding: 'var(--space-lg) var(--space-lg) calc(var(--space-lg) + env(safe-area-inset-bottom, 0px))'
                },
                [`${sidebar}::backdrop`]: {
                    background: 'color-mix(in oklab, var(--color-base-100) 45%, black)',
                    opacity: '0.85'
                }
            }
        }
    }
};

export default patch;
