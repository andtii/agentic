/**
 * The session files and changes scopes (#563, `docs/design/HANDOFF.md` →
 * "Session files and changes"): the code surface the plain renderer draws
 * (the Monaco renderer paints the same tokens through its theme), the file
 * tree, the change and commit lists, the session bar, the ask-about-a-line
 * composer and the small parts they share. Declared with zero's public
 * `defineAnatomy`, pure data, like the kit's.
 *
 * Product state rides `data-tone` and presence attributes (`aria-current`,
 * `aria-selected`, `data-selected`), never `data-state`.
 */
import { defineAnatomy } from '@sigx/zero/anatomy';

/**
 * A read-only code surface: the viewer (`56px 3px 1fr`: number, change
 * stripe, text) or the diff (`48px 48px 20px 1fr` unified, two halves
 * split); rows tinted by `data-tone` (`live` added, `failed` removed),
 * hunk headers on `base-300`, a widget under the selected line.
 */
export const agCodeAnatomy = defineAnatomy('ag-code', {
    root: { element: 'div', tokens: ['color', 'text'] },
    row: { element: 'div', parent: 'root', tokens: ['color'] },
    num: { element: 'span', parent: 'row', tokens: ['color', 'text'] },
    stripe: { element: 'span', parent: 'row', tokens: ['color'] },
    marker: { element: 'span', parent: 'row', tokens: ['color', 'text'] },
    text: { element: 'span', parent: 'row', tokens: ['color', 'text'] },
    widget: { element: 'div', parent: 'root' },
    notice: { element: 'p', parent: 'root', tokens: ['color', 'text'] }
});

/** The 18 px status letter: M `working`, A `live`, D `failed`, R `working`, ? `dim`. */
export const agStatusTileAnatomy = defineAnatomy('ag-status-tile', {
    root: { element: 'span', tokens: ['color', 'radius-selector', 'text'] }
});

/** `+n −n` in mono 11 / 600, `live` and `failed`. */
export const agDiffCountsAnatomy = defineAnatomy('ag-diff-counts', {
    root: { element: 'span', tokens: ['text'] },
    added: { element: 'span', parent: 'root', tokens: ['color'] },
    removed: { element: 'span', parent: 'root', tokens: ['color'] }
});

/**
 * The Changes list column: a labelled group (`Uncommitted` with totals, `On
 * this branch` with the base), 40 px file rows (tile, name, folder truncated
 * from the start, counts; `aria-current` on the open one), commit rows, and
 * the read-only note at the foot.
 */
export const agChangesAnatomy = defineAnatomy('ag-changes', {
    root: { element: 'div' },
    group: { element: 'section', parent: 'root' },
    heading: { element: 'div', parent: 'group', tokens: ['text'] },
    label: { element: 'h3', parent: 'heading', tokens: ['color', 'text'] },
    aside: { element: 'span', parent: 'heading', tokens: ['color', 'text'] },
    item: { element: 'a', parent: 'group', tokens: ['color', 'radius-field'] },
    body: { element: 'span', parent: 'item' },
    name: { element: 'span', parent: 'body', tokens: ['color', 'text'] },
    folder: { element: 'span', parent: 'body', tokens: ['color', 'text'] },
    commit: { element: 'div', parent: 'group', tokens: ['color'] },
    meta: { element: 'span', parent: 'commit', tokens: ['color', 'text'] },
    subject: { element: 'span', parent: 'meta', tokens: ['color', 'text'] },
    empty: { element: 'p', parent: 'group', tokens: ['color', 'text'] },
    note: { element: 'p', parent: 'root', tokens: ['color', 'text'] }
});

/**
 * The folder tree's product row over zero's `TreeView` (#587): each row is a
 * TreeView item or branch trigger rendered `asChild` — 28 px, chevron (the
 * TreeView branch indicator) or its blank, icon, mono 12 name, a 6 px change
 * dot (`working` modified, `live` added), the selected row on `base-300` —
 * plus a folder's loading or error line and the legend under the tree.
 */
export const agFileTreeAnatomy = defineAnatomy('ag-file-tree', {
    item: { element: 'div', flags: ['selected', 'focus-visible'], tokens: ['color', 'radius-selector'] },
    toggle: { element: 'span', parent: 'item' },
    icon: { element: 'span', parent: 'item', tokens: ['color'] },
    name: { element: 'span', parent: 'item', tokens: ['text'] },
    dot: { element: 'span', parent: 'item', tokens: ['color'] },
    status: { element: 'p', tokens: ['color', 'text'] },
    legend: { element: 'div', tokens: ['color', 'text'] }
});

/** The `Go to file` search: icon, zero's `Combobox` over the paths, a zero `Kbd` hint. */
export const agFindAnatomy = defineAnatomy('ag-find', {
    root: { element: 'div', tokens: ['color', 'radius-field'] },
    icon: { element: 'span', parent: 'root', tokens: ['color'] }
});

/**
 * The bar under the topbar on a session's views: link tabs (`Transcript`,
 * `Changes n`, `Files`; `aria-current="page"` on the open one, a 2 px
 * `live` underline), a divider, the agent tile, `machine / account`, the
 * branch chip, `n ahead of base`, and the view controls on the right.
 */
export const agSessionBarAnatomy = defineAnatomy('ag-session-bar', {
    root: { element: 'div', tokens: ['color'] },
    tabs: { element: 'nav', parent: 'root' },
    tab: { element: 'a', parent: 'tabs', tokens: ['color', 'text'] },
    count: { element: 'span', parent: 'tab', tokens: ['color', 'text'] },
    divider: { element: 'span', parent: 'root', tokens: ['color'] },
    context: { element: 'div', parent: 'root' },
    env: { element: 'span', parent: 'context', tokens: ['color', 'text'] },
    branch: { element: 'span', parent: 'context', tokens: ['color', 'radius-selector', 'text'] },
    ahead: { element: 'span', parent: 'context', tokens: ['color', 'text'] },
    controls: { element: 'div', parent: 'root' }
});

/**
 * A file's header over the diff or the viewer: the status tile, the path
 * (or breadcrumbs) with the file name in `text` 600, facts (counts, size),
 * and a slot for actions on the right.
 */
export const agFileHeaderAnatomy = defineAnatomy('ag-file-header', {
    root: { element: 'div', tokens: ['color'] },
    path: { element: 'span', parent: 'root', tokens: ['color', 'text'] },
    name: { element: 'span', parent: 'path', tokens: ['color', 'text'] },
    sep: { element: 'span', parent: 'path', tokens: ['color'] },
    facts: { element: 'span', parent: 'root', tokens: ['color', 'text'] },
    actions: { element: 'div', parent: 'root' }
});

/** "Ask <agent> about line n": head (tile, title, `file:line`), textarea, note, Cancel / Send. */
export const agLineComposerAnatomy = defineAnatomy('ag-line-composer', {
    root: { element: 'form', tokens: ['color', 'radius-box'] },
    head: { element: 'div', parent: 'root' },
    title: { element: 'span', parent: 'head', tokens: ['color', 'text'] },
    ref: { element: 'span', parent: 'head', tokens: ['color', 'text'] },
    input: { element: 'textarea', parent: 'root', tokens: ['color', 'radius-field', 'text'] },
    foot: { element: 'div', parent: 'root' },
    note: { element: 'span', parent: 'foot', tokens: ['color', 'text'] }
});

export const codeAnatomies = [
    agCodeAnatomy,
    agStatusTileAnatomy,
    agDiffCountsAnatomy,
    agChangesAnatomy,
    agFileTreeAnatomy,
    agFindAnatomy,
    agSessionBarAnatomy,
    agFileHeaderAnatomy,
    agLineComposerAnatomy
] as const;
