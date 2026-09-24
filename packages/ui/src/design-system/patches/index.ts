/**
 * The handoff's re-tuning of zero-daisyui's recipes (`docs/design/HANDOFF.md`
 * → "Element states", "Components"): one `RecipePatch` per scope, one file
 * per patch, applied by `extendDesignSystem` in `../index.ts`.
 *
 * A patch states only what the handoff changes; daisy's own reasoning (ink
 * mixes, RTL guards, presence transitions) stays in force underneath.
 * Objects merge per key, arrays and scalars replace, `null` deletes, and a
 * `compoundVariants` entry merges into daisy's entry with the same `match`
 * (or is appended). The empty patches are registered so the issue that
 * fills one edits only its own file.
 */
import type { RecipePatch } from '@sigx/zero-kit/define';
import button from './button.js';
import input from './input.js';
import textarea from './textarea.js';
import select from './select.js';
import combobox from './combobox.js';
import field from './field.js';
import switchPatch from './switch.js';
import badge from './badge.js';
import dialog from './dialog.js';
import table from './table.js';
import timeline from './timeline.js';
import card from './card.js';
import breadcrumbs from './breadcrumbs.js';
import tabs from './tabs.js';
import collapsible from './collapsible.js';
import toggleGroup from './toggle-group.js';
import skeleton from './skeleton.js';
import navbar from './navbar.js';
import avatar from './avatar.js';
import emptyState from './empty-state.js';
import drawer from './drawer.js';
import navList from './nav-list.js';
import progress from './progress.js';
import alert from './alert.js';

/** Scope → the patch applied to daisy's recipe for it. */
export const patches: Record<string, RecipePatch> = {
    button,
    input,
    textarea,
    select,
    combobox,
    field,
    switch: switchPatch,
    badge,
    dialog,
    table,
    timeline,
    card,
    breadcrumbs,
    tabs,
    collapsible,
    'toggle-group': toggleGroup,
    skeleton,
    navbar,
    avatar,
    'empty-state': emptyState,
    drawer,
    'nav-list': navList,
    progress,
    alert
};
