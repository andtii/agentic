/**
 * The app component kit's anatomies — the `ag-*` scopes `@agentic/ui`
 * publishes beside the `ai-*` transcript fragment (`docs/design/HANDOFF.md`
 * → "Components"). Declared with zero's public `defineAnatomy` so the
 * data-only fragment entry can import them without loading a component.
 *
 * Product state never rides `data-state` (zero governs that vocabulary):
 * a pill's colour is the `tone` axis (`data-tone`), an inbox row's kind the
 * `kind` axis (`data-kind`), and presence flags are modifiers
 * (`data-mod-hollow`, `data-mod-selected`, …) — all declared in
 * `design-system/tokens.ts`, wired in `./recipes.ts`.
 */
import { defineAnatomy } from '@sigx/zero/anatomy';

/** A status pill or tag: dot + mono label, tinted by `tone`; `hollow` for idle states, `outline` for tags. */
export const agPillAnatomy = defineAnatomy('ag-pill', {
    root: { element: 'span', tokens: ['color', 'radius-selector', 'text'] },
    dot: { element: 'span', parent: 'root', tokens: ['color'] },
    label: { element: 'span', parent: 'root', tokens: ['text'] }
});

/** The identity tile: a square mono monogram in the agent's hue; people are circles (`circle`). */
export const agAgentTileAnatomy = defineAnatomy('ag-agent-tile', {
    root: { element: 'span', tokens: ['color', 'radius-field', 'text'] },
    monogram: { element: 'span', parent: 'root', tokens: ['text'] }
});

/** `machine / runtime / account` in mono, never one part alone (EXE-06), never wrapping. */
export const agEnvLineAnatomy = defineAnatomy('ag-env-line', {
    root: { element: 'span', tokens: ['color', 'text'] },
    machine: { element: 'span', parent: 'root', tokens: ['text'] },
    sep: { element: 'span', parent: 'root', tokens: ['color'] },
    runtime: { element: 'span', parent: 'root', tokens: ['text'] },
    account: { element: 'span', parent: 'root', tokens: ['text'] }
});

/** One "Needs you" inbox row: tile, kind pill + title, context line, actions; `compact` drops the context line. */
export const agNeedsItemAnatomy = defineAnatomy('ag-needs-item', {
    root: { element: 'article', tokens: ['color', 'radius-box'] },
    tile: { element: 'span', parent: 'root' },
    head: { element: 'div', parent: 'root', tokens: ['text'] },
    title: { element: 'span', parent: 'head', tokens: ['text'] },
    context: { element: 'p', parent: 'root', tokens: ['text'] },
    actions: { element: 'div', parent: 'root' }
});

/** One node of a delegation tree: depth rail, tile, title, agent + environment, wait reason, status; `selected`. */
export const agTaskNodeAnatomy = defineAnatomy('ag-task-node', {
    root: { element: 'div', tokens: ['color', 'radius-box'] },
    rail: { element: 'span', parent: 'root', tokens: ['color'] },
    card: { element: 'button', parent: 'root', tokens: ['color', 'radius-box'] },
    tile: { element: 'span', parent: 'card' },
    title: { element: 'span', parent: 'card', tokens: ['text'] },
    meta: { element: 'span', parent: 'card', tokens: ['text'] },
    wait: { element: 'span', parent: 'card', tokens: ['color', 'text'] },
    status: { element: 'span', parent: 'card' }
});

/** The connection strip at the sidebar foot: one row per signal (this browser, each machine). */
export const agConnectionAnatomy = defineAnatomy('ag-connection', {
    root: { element: 'ul', tokens: ['color', 'radius-box'] },
    row: { element: 'li', parent: 'root', tokens: ['text'] },
    dot: { element: 'span', parent: 'row', tokens: ['color'] },
    name: { element: 'span', parent: 'row', tokens: ['text'] },
    state: { element: 'span', parent: 'row', tokens: ['text'] }
});

/** One config version in the versions rail: `current`, proposed (tone `needs-you`) or past. */
export const agVersionAnatomy = defineAnatomy('ag-version', {
    root: { element: 'li', tokens: ['color', 'radius-box'] },
    head: { element: 'div', parent: 'root', tokens: ['text'] },
    meta: { element: 'span', parent: 'root', tokens: ['text'] },
    reason: { element: 'p', parent: 'root', tokens: ['text'] },
    actions: { element: 'div', parent: 'root' }
});

/** One execution environment (EXE-06): name, runtime + account, capacity meter, facts, fix line; tone `failed` for auth, `dim` offline. */
export const agEnvCardAnatomy = defineAnatomy('ag-env-card', {
    root: { element: 'article', tokens: ['color', 'radius-box'] },
    header: { element: 'div', parent: 'root' },
    name: { element: 'h3', parent: 'header', tokens: ['text'] },
    status: { element: 'span', parent: 'header', tokens: ['text'] },
    line: { element: 'p', parent: 'root', tokens: ['text'] },
    capacity: { element: 'div', parent: 'root', tokens: ['text'] },
    meter: { element: 'span', parent: 'capacity' },
    slot: { element: 'span', parent: 'meter', tokens: ['color'] },
    count: { element: 'span', parent: 'capacity', tokens: ['text'] },
    queued: { element: 'span', parent: 'capacity', tokens: ['color', 'text'] },
    facts: { element: 'dl', parent: 'root', tokens: ['text'] },
    'default-for': { element: 'dd', parent: 'facts' },
    fix: { element: 'p', parent: 'root', tokens: ['color', 'text'] },
    actions: { element: 'div', parent: 'root' }
});

/** One of the six named failure states (OPS-04): icon + name + mono signal caption, a detail, one action; the `kind` axis paints it. */
export const agFailureAnatomy = defineAnatomy('ag-failure', {
    root: { element: 'article', tokens: ['color', 'radius-box'] },
    header: { element: 'div', parent: 'root' },
    icon: { element: 'span', parent: 'header', tokens: ['color'] },
    name: { element: 'span', parent: 'header', tokens: ['color', 'text'] },
    signal: { element: 'span', parent: 'header', tokens: ['text'] },
    detail: { element: 'p', parent: 'root', tokens: ['text'] },
    actions: { element: 'div', parent: 'root' }
});

/** The banner over the content ("This browser is offline · Reconnecting…"): icon, text, mono state, an optional action. */
export const agBannerAnatomy = defineAnatomy('ag-banner', {
    root: { element: 'div', tokens: ['color', 'radius-box', 'text'] },
    icon: { element: 'span', parent: 'root', tokens: ['color'] },
    text: { element: 'span', parent: 'root', tokens: ['text'] },
    state: { element: 'span', parent: 'root', tokens: ['text'] },
    actions: { element: 'span', parent: 'root' }
});

/** An empty screen: one card (or one line with `compact`; dashed with `outline`) instead of an empty table. */
export const agEmptyAnatomy = defineAnatomy('ag-empty', {
    root: { element: 'div', tokens: ['color', 'radius-box'] },
    icon: { element: 'span', parent: 'root', tokens: ['color'] },
    title: { element: 'span', parent: 'root', tokens: ['text'] },
    caption: { element: 'p', parent: 'root', tokens: ['text'] },
    actions: { element: 'div', parent: 'root' }
});

export const kitAnatomies = [
    agPillAnatomy,
    agAgentTileAnatomy,
    agEnvLineAnatomy,
    agNeedsItemAnatomy,
    agTaskNodeAnatomy,
    agConnectionAnatomy,
    agVersionAnatomy,
    agEnvCardAnatomy,
    agFailureAnatomy,
    agBannerAnatomy,
    agEmptyAnatomy
] as const;
