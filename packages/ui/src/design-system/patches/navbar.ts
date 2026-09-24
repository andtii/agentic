import type { RecipePatch } from '@sigx/zero-kit/define';

// Navbar: the shell's topbar row — 60 px, no fill of its own (shell.css paints the bar).
const patch: RecipePatch = {
    parts: {
        root: { base: { minBlockSize: 'var(--ag-topbar-h)', padding: '0', background: 'transparent', gap: 'var(--space-md)' } },
        end: { base: { gap: '10px' } }
    }
};

export default patch;
