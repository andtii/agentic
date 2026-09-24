import { component, type Define } from 'sigx';
import { useRoute, useRouter } from '@sigx/router';
import type { PluginReadiness } from '@agentic/core';
import type { PluginView } from '@agentic/platform';
import { CategoryMenu } from '@agentic/ui';
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

/** The category menu over one workspace's plugins; its links keep the page's search and status, and go through the router. */
const Menu = component<MenuProps>(({ props }) => {
    const route = useRoute();
    const router = useRouter();
    return () => (
        <div onClick={(e: MouseEvent) => followLink(e, router)}>
            <CategoryMenu
                label="Plugin categories"
                current={menuCurrent(props.kind)}
                groups={pluginMenu(props.plugins, props.readiness, { q: queryOf(route.query.q), status: statusFilterOf(queryOf(route.query.status)) })}
            />
        </div>
    );
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
 * workspace's plugins by category; `?kind=` selects its item.
 */
export const PluginsLayout = component<PluginsLayoutProps>(({ props, slots }) => () => (
    <div data-plugins-layout data-kind={props.kind}>
        <div data-plugins-menu>{slots.menu ? slots.menu() : dataMode() === 'live' ? <LiveMenu kind={props.kind} /> : <MockMenu kind={props.kind} />}</div>
        <div data-plugins-content>{slots.default?.()}</div>
    </div>
));
