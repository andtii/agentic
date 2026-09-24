import type { RecipePatch } from '@sigx/zero-kit/define';

// Dialog: 520 px on base-300, radius 10, padding 24, the only shadow in the system, a 160 ms rise.
const patch: RecipePatch = {
    parts: {
        popup: {
            base: {
                padding: 'var(--space-2xl)',
                maxWidth: '520px',
                background: 'var(--color-base-300)',
                borderRadius: 'var(--ag-radius-xl)',
                border: 'var(--border) solid var(--ag-line-strong)'
            },
            states: { open: { animation: 'zero-daisy-pop var(--duration-fast) var(--ease-standard)' } }
        },
        backdrop: { base: { background: 'oklch(3% 0.005 160 / 0.7)' } },
        title: { base: { fontSize: 'var(--text-xl)', fontWeight: 'var(--weight-semibold)', marginBlockEnd: 'var(--space-sm)' } },
        description: { base: { color: 'var(--ag-text-muted)', marginBlockEnd: 'var(--space-xl)', fontSize: 'var(--text-md)' } },
        footer: { base: { gap: 'var(--space-sm)', marginBlockStart: 'var(--space-2xl)', flexWrap: 'wrap' } }
    }
};

export default patch;
