import { component, useHead } from 'sigx';
import { Link, RouterView, useRoute } from '@sigx/router';
import { ThemeProvider, themeInitScript } from '@sigx/zero';
import { Breadcrumbs } from '@sigx/zero-daisyui/components';
import { AppShell } from '@agentic/ui';
import { CRUMBS, NAV_GROUPS } from './nav';
import { machines } from './mock/data';
import { topbarFor } from './components/topbar';

/** Schibsted Grotesk (interface) + JetBrains Mono (anything a machine said), 400–700, swapped in. */
const FONTS_HREF = 'https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap';

/**
 * The root component: the responsive shell around the routed page.
 *
 * `themeInitScript` restores a persisted explicit theme before first paint;
 * `useHead` puts it into the server-rendered <head> (priority -1: ahead of
 * everything else) together with the font links. `ThemeProvider` gives
 * server renders a per-request theme controller — `useTheme()` throws on
 * the server without one.
 */
export const App = component(() => {
    useHead({
        titleTemplate: '%s · agentic',
        script: [{ innerHTML: themeInitScript() }],
        link: [
            { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
            { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
            { rel: 'stylesheet', href: FONTS_HREF }
        ],
        priority: -1
    });
    const route = useRoute();

    const crumbs = (): { label: string; href: string; current?: boolean }[] => {
        const root = CRUMBS[String(route.name ?? '')];
        if (!root) return [];
        const id = route.params.id;
        const isRoot = route.path === root.href;
        return isRoot || !id ? [{ ...root, current: true }] : [root, { label: topbarFor(route)?.crumb ?? String(id), href: route.path, current: true }];
    };

    return () => (
        <ThemeProvider>
            <AppShell
                brand="agentic"
                groups={NAV_GROUPS()}
                currentPath={route.path}
                flush={route.name === 'chat'}
                slots={{
                    link: ({ item }) => <Link to={item.href}>{item.label}</Link>,
                    actions: () => topbarFor(route)?.actions?.() ?? null,
                    breadcrumb: () => (
                        <Breadcrumbs label="Breadcrumb">
                            {crumbs().map(crumb => (
                                <Breadcrumbs.Item>
                                    {crumb.current
                                        ? <Breadcrumbs.Link current>{crumb.label}</Breadcrumbs.Link>
                                        : <Breadcrumbs.Link asChild><Link to={crumb.href}>{crumb.label}</Link></Breadcrumbs.Link>}
                                    {crumb.current ? null : <Breadcrumbs.Separator>›</Breadcrumbs.Separator>}
                                </Breadcrumbs.Item>
                            ))}
                        </Breadcrumbs>
                    ),
                    // The always-visible half of failure distinction (OPS-04): this
                    // browser's socket, then each machine. Live signals land with #87 / #46.
                    connection: () => (
                        <ul data-connection>
                            <li data-connection-row data-state="on"><span>This browser</span><span>live</span></li>
                            {machines.map(m => (
                                <li data-connection-row data-state={m.online ? 'on' : 'off'}>
                                    <span>{m.name}</span><span>{m.online ? 'online' : 'offline'}</span>
                                </li>
                            ))}
                        </ul>
                    ),
                    user: () => (
                        <>
                            <span data-user-avatar aria-hidden="true">WS</span>
                            <span data-user-name>Workspace<small>ws:local</small></span>
                        </>
                    )
                }}
            >
                <RouterView />
            </AppShell>
        </ThemeProvider>
    );
});
