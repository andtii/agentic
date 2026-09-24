import type { RecipePatch } from '@sigx/zero-kit/define';
import { mono } from './shared.js';

// Badge: the 22 px mono pill every status pill and tag is built on.
const patch: RecipePatch = {
    tokens: { '--badge-fill': 'transparent', '--badge-ink': 'var(--ag-text-muted)' },
    parts: {
        root: {
            base: {
                height: 'var(--ag-pill-h)',
                padding: '0 var(--space-sm)',
                borderColor: 'var(--ag-line-strong)',
                fontFamily: mono,
                fontSize: 'var(--text-xs)',
                fontWeight: 'var(--weight-medium)',
                letterSpacing: 'var(--tracking-wide)',
                lineHeight: 'var(--leading-none)'
            }
        }
    }
};

export default patch;
