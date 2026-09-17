/**
 * The composer anatomy — one `ai-composer` scope declared with zero's public
 * `defineAnatomy` (data only; the fragment entry imports this file).
 *
 * The text field itself is zero's `Textarea` inside the `input` part and the
 * buttons are zero's `Button`s inside `actions`; those keep their own scopes
 * and take the adopting design system's own recipes. The `mentions` listbox
 * carries `open | closed` and is hidden by the runtime while closed.
 */
import { defineAnatomy } from '@sigx/zero/anatomy';

export const aiComposerAnatomy = defineAnatomy('ai-composer', {
    root: { element: 'form', tokens: ['color', 'radius-box'] },
    attachments: { element: 'ul', parent: 'root' },
    attachment: { element: 'li', parent: 'attachments', tokens: ['color', 'radius-selector', 'text'] },
    input: { element: 'div', parent: 'root' },
    mentions: { element: 'ul', parent: 'input', states: ['open', 'closed'], hiddenIn: ['closed'], tokens: ['color', 'radius-box'] },
    mention: { element: 'li', parent: 'mentions', flags: ['highlighted'], tokens: ['color', 'text'] },
    actions: { element: 'div', parent: 'root' }
});
