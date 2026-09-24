import type { RecipePatch } from '@sigx/zero-kit/define';
import { motion, ring } from './shared.js';

// Tabs: an underline bar — the tab strip of the agent page.
const patch: RecipePatch = {
    parts: {
        list: { base: { alignSelf: 'stretch', padding: '0', gap: '0', background: 'transparent', borderRadius: '0', borderBlockEnd: 'var(--border) solid var(--ag-line)' } },
        tab: {
            base: {
                padding: 'var(--space-md) var(--space-lg)',
                fontSize: 'var(--text-md)',
                color: 'var(--ag-text-muted)',
                borderRadius: '0',
                borderBlockEnd: '2px solid transparent',
                marginBlockEnd: 'calc(-1 * var(--border))',
                transition: `color ${motion}, border-color ${motion}`
            },
            states: { active: { background: 'transparent', boxShadow: 'none', color: 'var(--color-base-content)', borderBlockEndColor: 'var(--color-primary)' }, 'focus-visible': ring }
        }
    }
};

export default patch;
