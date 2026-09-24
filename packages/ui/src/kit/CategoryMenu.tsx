/**
 * `CategoryMenu` — the grouped category menu left of a catalogue page
 * (`docs/design/plugins/HANDOFF-plugins.md` → "All plugins", board
 * `Plugins`): a 232 px column around zero's `NavList` (`<nav aria-label>`),
 * groups under a mono label, 34 px links with a mono count. The current item carries
 * `aria-current="page"` (zero's `current`); an empty category shows its `0`
 * in `text-dim` and stays a link; a `badge` item paints its count as the
 * amber `needs-you` badge ("Needs attention").
 */
import { component, type Define } from '@sigx/runtime-core';
import { NavList } from '@sigx/zero';
import { createId } from '@sigx/zero/behaviors';

export interface CategoryMenuItem {
    readonly id: string;
    readonly label: string;
    readonly count: number;
    /** Paint the count as the amber `needs-you` badge (while it is above 0). */
    readonly badge?: boolean;
    readonly href: string;
}

export interface CategoryMenuGroup {
    /** The group's mono label ("Runtimes"); omit for the unlabelled top group. */
    readonly label?: string;
    readonly items: readonly CategoryMenuItem[];
}

export type CategoryMenuProps =
    & Define.Prop<'groups', readonly CategoryMenuGroup[], true>
    /** The current item's `id`. */
    & Define.Prop<'current', string>
    /** The navigation landmark's accessible name. */
    & Define.Prop<'label', string, true>
    & Define.Prop<'class', string>;

// zero's parts forward no `style`, so the look sits on the menu's own elements: the column box
// around the landmark, the heading, the link (`asChild`) and its count. Board `Plugins`: the column
// is 232 px with 20 / 12 px padding and a rule on its right; the recipe keeps the group rhythm.
// The 232 px is a literal, not `--ag-sidebar-w`, so resizing the shell sidebar leaves this column alone.
const columnStyle = 'inline-size: 232px; flex-shrink: 0; box-sizing: border-box; padding: var(--space-xl) var(--space-md); border-inline-end: var(--border) solid var(--ag-line)';
// The mono label voice (the kit's `Label`), inset to the links' text.
const headingStyle = 'padding: 0 calc(var(--space-sm) + var(--space-2xs)); font-family: var(--font-mono); font-size: var(--text-xs); font-weight: var(--weight-medium); letter-spacing: var(--tracking-wider); text-transform: uppercase; color: var(--ag-text-dim)';
const linkBase = 'display: flex; align-items: center; block-size: 34px; box-sizing: border-box; padding: 0 calc(var(--space-sm) + var(--space-2xs)); gap: var(--space-sm); border-radius: var(--radius-field); text-decoration: none; font-size: var(--text-md)';
const countStyle = 'flex-shrink: 0; font-family: var(--font-mono); font-size: var(--text-xs); font-weight: var(--weight-normal); color: var(--ag-text-dim)';
const badgeStyle = 'flex-shrink: 0; display: inline-grid; place-items: center; box-sizing: border-box; min-inline-size: 20px; block-size: 20px; padding: 0 var(--space-xs); border-radius: var(--radius-selector); background: var(--color-warning); color: var(--color-warning-content); font-family: var(--font-mono); font-size: var(--text-xs); font-weight: var(--weight-bold); line-height: var(--leading-none)';

function linkStyle(current: boolean, empty: boolean): string {
    if (current) return `${linkBase}; color: var(--color-base-content); font-weight: var(--weight-semibold)`;
    return `${linkBase}; color: ${empty ? 'var(--ag-text-dim)' : 'var(--ag-text-muted)'}; font-weight: var(--weight-medium)`;
}

export const CategoryMenu = component<CategoryMenuProps>(({ props }) => {
    const idBase = createId('ag-category-menu');
    const item = (entry: CategoryMenuItem) => {
        const current = entry.id === props.current;
        const empty = entry.count === 0;
        const badge = entry.badge === true && !empty;
        return (
            <NavList.Item>
                <NavList.Link href={entry.href} current={current} asChild>
                    {(part) => (
                        <a {...part} data-category={entry.id} data-empty={empty ? '' : undefined} style={linkStyle(current, empty)}>
                            <span style="flex-grow: 1; min-inline-size: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{entry.label}</span>
                            <span data-count="" data-tone={badge ? 'needs-you' : empty ? 'dim' : undefined} style={badge ? badgeStyle : countStyle}>{entry.count}</span>
                        </a>
                    )}
                </NavList.Link>
            </NavList.Item>
        );
    };
    return () => (
        <div data-category-menu="" class={props.class} style={columnStyle}>
            <NavList.Root label={props.label}>
                {props.groups.map((group, index) => {
                    const headingId = `${idBase}-${index}`;
                    return (
                        <NavList.Group aria-labelledby={group.label ? headingId : undefined}>
                            {group.label ? <div id={headingId} data-category-heading="" style={headingStyle}>{group.label}</div> : null}
                            <NavList.List>{group.items.map(item)}</NavList.List>
                        </NavList.Group>
                    );
                })}
            </NavList.Root>
        </div>
    );
}, { name: 'CategoryMenu' });
