/**
 * What the session files and changes scopes claim of the design system's
 * vocabulary (#563). Only the status tile paints the `tone` axis on its
 * root; the other scopes carry state on parts (`data-tone` on a diff row or
 * a tree dot, `aria-current`, `aria-selected`, `data-selected`) through
 * recipe selectors and so make no claim (the validator refuses an empty one).
 */
import type { ScopeVocabulary } from '@sigx/zero-kit';

export const codeScopes: Record<string, ScopeVocabulary> = {
    'ag-status-tile': { axes: { tone: ['working', 'live', 'failed', 'dim'] } }
};
