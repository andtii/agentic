import type { RecipePatch } from '@sigx/zero-kit/define';
import { ring } from './shared.js';

// Switch: 40 × 24 (daisy's size × 6 with the selector unit), off = base-300 track, on = `live` track with a `live-ink` knob.
const patch: RecipePatch = {
    parts: {
        control: {
            base: { backgroundColor: 'var(--color-base-300)', boxShadow: 'none', borderColor: 'var(--ag-line-strong)' },
            states: {
                checked: { backgroundColor: 'var(--switch-accent)', borderColor: 'var(--switch-accent)', color: 'var(--color-base-100)' },
                'focus-visible': ring
            }
        },
        thumb: { base: { boxShadow: 'none', borderRadius: '9999px' } }
    }
};

export default patch;
