import type { RecipePatch } from '@sigx/zero-kit/define';

// Timeline: 8 px dot in the state colour, 1 px `line-strong` connector, plain text content.
const patch: RecipePatch = {
    tokens: { '--timeline-marker-size': 'var(--space-sm)', '--timeline-accent': 'var(--ag-text-muted)' },
    parts: {
        connector: { base: { background: 'var(--ag-line-strong)' } },
        content: { base: { border: 'none', background: 'transparent', padding: '0', margin: '0 var(--space-md) var(--space-md)', fontSize: 'var(--text-md)' } }
    }
};

export default patch;
