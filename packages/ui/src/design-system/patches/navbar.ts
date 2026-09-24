import type { RecipePatch } from '@sigx/zero-kit/define';

// Navbar: the shell's topbar row — 60 px, no fill of its own (shell.css paints the bar).
const patch: RecipePatch = {
    parts: {
        root: { base: { minBlockSize: 'var(--ag-topbar-h)', padding: '0', background: 'transparent', gap: 'var(--space-md)' } },
        end: { base: { gap: 'calc(var(--space-sm) + var(--space-2xs))' } }
    }
};

export default patch;
