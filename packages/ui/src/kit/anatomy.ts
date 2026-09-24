/**
 * The app component kit's anatomies — the `ag-*` scopes `@agentic/ui`
 * publishes beside the `ai-*` transcript fragment (`docs/design/HANDOFF.md`
 * → "Components"). Declared with zero's public `defineAnatomy` so the
 * data-only fragment entry can import them without loading a component.
 *
 * Status pills and tags (`Badge`), identity tiles (`Avatar`), empty and
 * failure cards (`EmptyState`) and quota bars (`Progress`) are zero parts
 * the design system's patches draw; they have no anatomy here.
 *
 * Product state never rides `data-state` (zero governs that vocabulary):
 * a row's colour is the `tone` axis (`data-tone`), an inbox row's kind the
 * `kind` axis (`data-kind`), and presence flags are modifiers
 * (`data-mod-hollow`, `data-mod-selected`, …) — all declared in
 * `design-system/tokens.ts`, wired in `./recipes.ts`.
 */
import { defineAnatomy } from '@sigx/zero/anatomy';

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
    /** What the environment's sessions cost the machine (#400): `CPU 12 % · 1.8 GB`, or why it is unknown. */
    load: { element: 'span', parent: 'capacity', tokens: ['color', 'text'] },
    facts: { element: 'dl', parent: 'root', tokens: ['text'] },
    'default-for': { element: 'dd', parent: 'facts' },
    fix: { element: 'p', parent: 'root', tokens: ['color', 'text'] },
    quota: { element: 'div', parent: 'root' },
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

/** A working folder as a field shows it (#191): the chip (`machine / environment · …\last\two`) and its Change / Clear actions. */
export const agWorkdirAnatomy = defineAnatomy('ag-workdir', {
    root: { element: 'div' },
    chip: { element: 'output', parent: 'root', tokens: ['color', 'radius-selector', 'text'] },
    actions: { element: 'span', parent: 'root' }
});

/**
 * The folder picker inside the working-folder dialog (#191): the environment
 * strip, the top level (Recent, Roots), the breadcrumb bar with its path
 * editor and git badge, the folder listbox, the state notices and the
 * inline new-worktree form.
 */
export const agWorkdirPickerAnatomy = defineAnatomy('ag-workdir-picker', {
    root: { element: 'div', tokens: ['color', 'text'] },
    envs: { element: 'div', parent: 'root' },
    env: { element: 'button', parent: 'envs', tokens: ['color', 'radius-field', 'text'] },
    'env-name': { element: 'span', parent: 'env', tokens: ['text'] },
    'env-note': { element: 'span', parent: 'env', tokens: ['color', 'text'] },
    section: { element: 'section', parent: 'root' },
    heading: { element: 'h3', parent: 'section', tokens: ['color', 'text'] },
    shortcuts: { element: 'ul', parent: 'section' },
    shortcut: { element: 'button', parent: 'shortcuts', tokens: ['color', 'radius-field', 'text'] },
    bar: { element: 'div', parent: 'root' },
    crumbs: { element: 'nav', parent: 'bar', tokens: ['text'] },
    crumb: { element: 'button', parent: 'crumbs', tokens: ['color', 'radius-selector', 'text'] },
    editor: { element: 'div', parent: 'bar' },
    list: { element: 'ul', parent: 'root', tokens: ['color', 'radius-box'] },
    item: { element: 'li', parent: 'list', tokens: ['color', 'text'] },
    name: { element: 'span', parent: 'item', tokens: ['text'] },
    notice: { element: 'p', parent: 'root', tokens: ['color', 'text'] },
    worktree: { element: 'div', parent: 'root', tokens: ['color', 'radius-box'] },
    actions: { element: 'div', parent: 'worktree' }
});

/** One plugin of the build (PLG-02, PLG-03): name + version, kind and readiness tags, description, the page's sections, dependents + configure; tone `dim` disabled, `needs-you` / `failed` when it needs the user, `selected` = the active plugin of its kind. */
export const agPluginCardAnatomy = defineAnatomy('ag-plugin-card', {
    root: { element: 'article', tokens: ['color', 'radius-box'] },
    header: { element: 'header', parent: 'root' },
    name: { element: 'h3', parent: 'header', tokens: ['text'] },
    version: { element: 'span', parent: 'name', tokens: ['color', 'text'] },
    tags: { element: 'div', parent: 'root' },
    readiness: { element: 'span', parent: 'tags', tokens: ['text'] },
    'readiness-detail': { element: 'span', parent: 'readiness', tokens: ['color', 'text'] },
    description: { element: 'p', parent: 'root', tokens: ['color', 'text'] },
    footer: { element: 'footer', parent: 'root', tokens: ['color', 'text'] },
    meta: { element: 'span', parent: 'footer' }
});

/** A write-only secret: SET / NOT SET with Replace and Remove, and the one-line editor that takes a new value. */
export const agSecretAnatomy = defineAnatomy('ag-secret', {
    root: { element: 'div' },
    state: { element: 'div', parent: 'root' },
    actions: { element: 'span', parent: 'state' },
    editor: { element: 'form', parent: 'root' }
});

/** A string → string map as name / value rows with a remove button each, and the add button. */
export const agMapFieldAnatomy = defineAnatomy('ag-map-field', {
    root: { element: 'div' },
    row: { element: 'div', parent: 'root' },
    actions: { element: 'div', parent: 'root' }
});

/** One provider limit window (#270): bold label, a bar filled to the utilization and coloured by status, "76% used", the reset time; dims when `stale`. */
export const agQuotaAnatomy = defineAnatomy('ag-quota', {
    root: { element: 'div', tokens: ['color', 'text'] },
    label: { element: 'span', parent: 'root', tokens: ['text'] },
    used: { element: 'span', parent: 'root', tokens: ['text'] },
    resets: { element: 'span', parent: 'root', tokens: ['text'] }
});

/** One account's limits: title, plan, how old, then its windows — or why the provider reports none (OPS-07). */
export const agQuotaPanelAnatomy = defineAnatomy('ag-quota-panel', {
    root: { element: 'section', tokens: ['color'] },
    header: { element: 'div', parent: 'root' },
    title: { element: 'span', parent: 'header', tokens: ['text'] },
    age: { element: 'span', parent: 'header', tokens: ['color', 'text'] },
    zone: { element: 'span', parent: 'header', tokens: ['color', 'text'] },
    reason: { element: 'p', parent: 'root', tokens: ['text'] }
});

/** A member's limits at a glance (#452): one ring per window that limits its model, the percent beside it and a one-word label. */
export const agQuotaRingsAnatomy = defineAnatomy('ag-quota-rings', {
    root: { element: 'div', tokens: ['color'] },
    item: { element: 'span', parent: 'root', tokens: ['color'] },
    ring: { element: 'svg', parent: 'item', tokens: ['color'] },
    value: { element: 'span', parent: 'item', tokens: ['text'] },
    label: { element: 'span', parent: 'item', tokens: ['text'] }
});

/**
 * A markdown document as prose (#490): the one part is the reading surface
 * whose recipe styles what `@sigx/richtext` renders inside it (`data-scope="richtext"`);
 * `compact` is the size a card's well shows it at.
 */
export const agMarkdownAnatomy = defineAnatomy('ag-markdown', {
    root: { element: 'div', tokens: ['color', 'radius-field', 'text'] }
});

export const kitAnatomies = [
    agEnvLineAnatomy,
    agNeedsItemAnatomy,
    agTaskNodeAnatomy,
    agConnectionAnatomy,
    agVersionAnatomy,
    agEnvCardAnatomy,
    agBannerAnatomy,
    agWorkdirAnatomy,
    agWorkdirPickerAnatomy,
    agPluginCardAnatomy,
    agSecretAnatomy,
    agMapFieldAnatomy,
    agQuotaAnatomy,
    agQuotaPanelAnatomy,
    agQuotaRingsAnatomy,
    agMarkdownAnatomy
] as const;
