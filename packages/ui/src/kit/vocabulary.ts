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

/** The `data-kind` values an inbox row carries (`kit/states/kinds.ts` holds the failure kinds; `interrupted` is both). */
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
    'ag-env-card': { axes: { tone: [...TONES] }, modifiers: ['selected'] },
    // The six named failure states — the `kind` values `FAILURES[kind].axis` renders (`client-offline` → `offline`).
    'ag-failure': { axes: { kind: ['offline', 'machine', 'auth', 'runtime', 'task', 'interrupted'], tone: ['muted', 'needs-you', 'failed'] } },
    'ag-banner': { axes: { tone: ['muted', 'needs-you', 'failed'] } },
    'ag-empty': { modifiers: ['compact', 'outline'] },
    // The working-folder picker (#191): selection rides ARIA (`aria-pressed`, `aria-selected`, `aria-current`).
    'ag-workdir': { modifiers: ['compact'] },
    'ag-workdir-picker': { modifiers: ['loading'] },
    // Plugins (#232): a ready plugin carries no tone; `selected` is the active plugin of a single-slot kind.
    // `ag-secret` and `ag-map-field` paint no tone and no modifier, so they make no claim (an empty one is refused).
    'ag-plugin-card': { axes: { tone: ['dim', 'needs-you', 'failed'] }, modifiers: ['selected'] },
    // Provider limits (#270): ok is `live`, warning `needs-you`, exhausted `failed`, unknown `muted`; `stale` dims an old snapshot.
    'ag-quota': { axes: { tone: ['muted', 'live', 'needs-you', 'failed'] }, modifiers: ['stale', 'compact'] },
    'ag-quota-panel': { modifiers: ['stale', 'compact'] },
    // A member's rings (#452): each ring carries its window's tone on its `item`; `stale` dims them all.
    'ag-quota-rings': { modifiers: ['stale'] }
};
