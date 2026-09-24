import { component, signal, watch, type Define } from 'sigx';
import { useRoute, useRouter } from '@sigx/router';
import type { PluginReadiness } from '@agentic/core';
import type { PluginView } from '@agentic/platform';
import { CategoryMenu, SelectField, type CategoryMenuGroup } from '@agentic/ui';
import { useActorDefs, useViewer } from '../../actors/defs';
import { dataMode } from '../../data-mode';
import { listPlugins } from '../../mock/plugins-list';
import { queryOf } from '../session/files';
import { menuCurrent, pluginMenu, statusFilterOf } from './list-model';
import { followLink, mockPluginFacts } from './PluginsList';
import { readinessById, useWorkspaceReadiness } from './readiness';

export type PluginsLayoutProps =
    /** The `?kind=` the page shows (`connector`, a plugin kind, a runtime kind, `attention`, or none for all). */
    & Define.Prop<'kind', string>
    & Define.Slot<'default'>
    /** Replaces the category menu. */
    & Define.Slot<'menu'>;

type MenuProps =
    & Define.Prop<'kind', string>
    & Define.Prop<'plugins', readonly PluginView[], true>
    & Define.Prop<'readiness', Readonly<Record<string, PluginReadiness>>, true>;

/**
 * Below 768 px (#641) the menu is one `Select` above the content: every item as an option (its group as the option
 * group, its count after the label); choosing one follows its link, keeping search and status. The stylesheet shows
 * either this or the menu column, never both.
 */
const CategorySelect = component<Define.Prop<'current', string, true> & Define.Prop<'groups', readonly CategoryMenuGroup[], true>>(({ props }) => {
    const router = useRouter();
    const st = signal({ value: props.current });
    watch(() => props.current, (current) => { st.value = current; });
    watch(() => st.value, (value) => {
        if (value === props.current) return;
        const item = props.groups.flatMap((g) => g.items).find((i) => i.id === value);
        if (item) void router.push(item.href);
    });
    return () => (
        <div data-plugins-select>
            <SelectField
                name="plugin-category"
                label="Category"
                model={() => st.value}
                options={props.groups.flatMap((g) => g.items.map((i) => ({ value: i.id, label: `${i.label} · ${i.count}`, ...(g.label ? { group: g.label } : {}) })))}
            />
        </div>
    );
}, { name: 'CategorySelect' });

/** The category menu over one workspace's plugins; its links keep the page's search and status, and go through the router. */
const Menu = component<MenuProps>(({ props }) => {
    const route = useRoute();
    const router = useRouter();
    return () => {
        const groups = pluginMenu(props.plugins, props.readiness, { q: queryOf(route.query.q), status: statusFilterOf(queryOf(route.query.status)) });
        return (
            <>
                <div data-plugins-menu-column onClick={(e: MouseEvent) => followLink(e, router)}>
                    <CategoryMenu label="Plugin categories" current={menuCurrent(props.kind)} groups={groups} />
                </div>
                <CategorySelect current={menuCurrent(props.kind)} groups={groups} />
            </>
        );
    };
});

/** The mock workspace's menu: the fixtures `/plugins` lists. */
const MockMenu = component<Define.Prop<'kind', string>>(({ props }) => () => <Menu kind={props.kind} plugins={listPlugins} readiness={readinessById(listPlugins, mockPluginFacts())} />);

/** The workspace's menu, from the same live reads the list makes (`useWorkspaceReadiness`). */
const LiveMenu = component<Define.Prop<'kind', string>>(({ props }) => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const ready = useWorkspaceReadiness(defs, viewer);
    return () => <Menu kind={props.kind} plugins={ready.overview()?.plugins ?? []} readiness={ready.byId()} />;
});

/**
 * The `/plugins` frame (#628, #637): the 232 px category menu (board
 * `Plugins`), then the view `?kind=` picks. The menu's counts are the
 * workspace's plugins by category; `?kind=` selects its item. Below 768 px
 * the same items are a `Select` above the view (#641).
 */
export const PluginsLayout = component<PluginsLayoutProps>(({ props, slots }) => () => (
    <div data-plugins-layout data-kind={props.kind}>
        <div data-plugins-menu>{slots.menu ? slots.menu() : dataMode() === 'live' ? <LiveMenu kind={props.kind} /> : <MockMenu kind={props.kind} />}</div>
        <div data-plugins-content>{slots.default?.()}</div>
    </div>
));
