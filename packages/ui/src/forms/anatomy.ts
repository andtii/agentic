/**
 * The `ai-form` scope — the layout parts `AgentForm` and `SchemaForm` stamp
 * around zero's fields (#89, #232). Declared with zero's public
 * `defineAnatomy`, pure data like the kit's, so the fragment entry lists the
 * scope and the components write `aiFormAnatomy.scope` instead of a literal.
 * No recipe: the app lays the form out (`apps/web/src/styles/pages/`), the
 * fields inside are zero's.
 */
import { defineAnatomy } from '@sigx/zero/anatomy';

export const aiFormAnatomy = defineAnatomy('ai-form', {
    root: { element: 'form' },
    /** The two-column layout: the sections column beside the save rail. */
    sections: { element: 'div', parent: 'root' },
    rail: { element: 'aside', parent: 'root' },
    /** One fieldset; its legend names the group (visually hidden in the sections layout). */
    section: { element: 'fieldset', parent: 'root' },
    'section-title': { element: 'legend', parent: 'section', tokens: ['text'] },
    /** The sections layout's title-and-hint column beside the controls. */
    'section-head': { element: 'div', parent: 'section' },
    'section-heading': { element: 'span', parent: 'section-head', tokens: ['text'] },
    'section-hint': { element: 'p', parent: 'section-head', tokens: ['color', 'text'] },
    'section-body': { element: 'div', parent: 'section' },
    /** A segmented approval row: the category's label and hint, then its allow / ask / deny control. */
    'policy-row': { element: 'div', parent: 'section' },
    'policy-label': { element: 'div', parent: 'policy-row', tokens: ['color', 'text'] },
    hint: { element: 'p', parent: 'root', tokens: ['color', 'text'] },
    actions: { element: 'div', parent: 'root' }
});

/** The `ai-form` scope name, for the components' `data-scope`. */
export const FORM_SCOPE = aiFormAnatomy.scope;
