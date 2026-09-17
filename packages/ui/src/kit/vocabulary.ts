/**
 * What each `ag-*` scope offers of the design system's vocabulary — the
 * per-scope claims `tokens.scopes` carries (`docs/design/HANDOFF.md` →
 * "States and interactions"). A scope names the whole `tone` list when it
 * paints every tone; a subset is a real restriction (a version row is only
 * ever "needs review"). Pure data, shared by `design-system/tokens.ts`.
 */
import type { ScopeVocabulary } from '@sigx/zero-kit';

/** The product tones — `data-tone`, never `data-state`. */
export const TONES = ['muted', 'dim', 'live', 'working', 'needs-you', 'failed'] as const;
export type Tone = (typeof TONES)[number];

/** The `data-kind` values an inbox row carries; the failure kinds join in the states issue. */
export const NEEDS_KINDS = ['approval', 'input', 'interrupted'] as const;
export type NeedsKind = (typeof NEEDS_KINDS)[number];

export const kitScopes: Record<string, ScopeVocabulary> = {
    'ag-pill': { axes: { tone: [...TONES] }, modifiers: ['hollow', 'outline'] },
    'ag-agent-tile': { modifiers: ['circle'] },
    'ag-env-line': { axes: { tone: [...TONES] } },
    'ag-needs-item': { axes: { kind: [...NEEDS_KINDS] }, modifiers: ['compact'] },
    'ag-task-node': { modifiers: ['selected'] },
    'ag-connection': { axes: { tone: [...TONES] }, modifiers: ['hollow'] },
    'ag-version': { axes: { tone: ['needs-you'] }, modifiers: ['current'] },
    'ag-env-card': { axes: { tone: [...TONES] }, modifiers: ['selected'] }
};
