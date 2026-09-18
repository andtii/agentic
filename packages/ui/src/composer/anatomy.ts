/**
 * The composer anatomy — one `ai-composer` scope declared with zero's public
 * `defineAnatomy` (data only; the fragment entry imports this file).
 *
 * The text field itself is zero's `Textarea` inside the `input` part and the
 * buttons are the kit's `Button`s (zero's `button` anatomy) inside
 * `actions`; those keep their own scopes and take the adopting design
 * system's own recipes. The `addressing` row says who a message goes to:
 * "To" plus one `recipient` chip per resolved agent and a right-aligned
 * `hint` (`docs/design/HANDOFF.md` → `ai-composer`). The `mentions` listbox
 * carries `open | closed` and is hidden by the runtime while closed.
 *
 * The root takes the governed `highlighted` flag while a drag carrying files
 * hovers it (zero's `FileUpload` spells drag-over the same way). Each
 * `attachment` chip carries its upload as a governed lifecycle state —
 * `loading` (uploading) · `complete` (ready) · `error` — with a
 * `thumbnail` for images, its `attachment-name` / `attachment-size`, a
 * `spinner` while loading and the `attachment-error` line.
 */
import { defineAnatomy } from '@sigx/zero/anatomy';

export const aiComposerAnatomy = defineAnatomy('ai-composer', {
    root: { element: 'form', flags: ['highlighted'], tokens: ['color', 'radius-box'] },
    addressing: { element: 'div', parent: 'root', tokens: ['text'] },
    recipient: { element: 'span', parent: 'addressing', tokens: ['color', 'radius-selector', 'text'] },
    hint: { element: 'span', parent: 'addressing', tokens: ['color', 'text'] },
    attachments: { element: 'ul', parent: 'root' },
    attachment: { element: 'li', parent: 'attachments', states: ['loading', 'complete', 'error'], tokens: ['color', 'radius-selector', 'text'] },
    thumbnail: { element: 'img', parent: 'attachment', tokens: ['radius-selector'] },
    'attachment-name': { element: 'span', parent: 'attachment', tokens: ['text'] },
    'attachment-size': { element: 'span', parent: 'attachment', tokens: ['color', 'text'] },
    /** The upload's spinner — rendered only while the chip is `loading`. */
    spinner: { element: 'span', parent: 'attachment', tokens: ['color'] },
    'attachment-error': { element: 'span', parent: 'attachment', tokens: ['color', 'text'] },
    input: { element: 'div', parent: 'root' },
    mentions: { element: 'ul', parent: 'input', states: ['open', 'closed'], hiddenIn: ['closed'], tokens: ['color', 'radius-box'] },
    mention: { element: 'li', parent: 'mentions', flags: ['highlighted'], tokens: ['color', 'text'] },
    actions: { element: 'div', parent: 'root' },
    /** The key hint: `Enter to send · Shift+Enter newline`, mono 11. */
    keys: { element: 'span', parent: 'actions', tokens: ['color', 'text'] }
});
