import { component, useHead } from 'sigx';
import { Link, RouterView, useRoute } from '@sigx/router';
import { ThemeProvider, themeInitScript } from '@sigx/zero';
import { Breadcrumbs } from '@sigx/zero-daisyui/components';
import { AppShell, ConnectionStrip, connectionRows, OfflineBanner } from '@agentic/ui';
import { NAV_GROUPS } from './nav';
import { backOf, titleOf, trailFor } from './crumbs';
import { machines } from './mock/data';
import { topbarFor } from './components/topbar';
import { clientConnection, LiveConnection } from './components/status';
import { dataMode } from './data-mode';

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
 *
 * The topbar is the route's: its trail (`crumbs.ts`) becomes the breadcrumb
 * at ≥ 768 px and the app bar's title + back link below; the page's
 * contribution (`components/topbar.ts`) supplies the entity name, the
 * actions, the sub-line and the phone's one right slot.
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
    const topbar = () => topbarFor(route);
    const trail = () => trailFor(route, topbar());

    return () => {
        const top = topbar();
        const crumbs = trail();
        return (
            <ThemeProvider>
                <AppShell
                    brand="agentic"
                    groups={NAV_GROUPS()}
                    currentPath={route.path}
                    flush={route.name === 'chat'}
                    title={titleOf(crumbs)}
                    back={backOf(crumbs)}
                    slots={{
                        link: ({ item, icon }) => <Link to={item.href}>{icon}{item.label}</Link>,
                        back: ({ href, icon }) => <Link to={href}><span data-visually-hidden="">Back</span>{icon}</Link>,
                        actions: () => top?.actions?.() ?? null,
                        ...(top?.subtitle ? { subtitle: top.subtitle } : {}),
                        ...(top?.phoneAction ? { phoneAction: top.phoneAction } : {}),
                        breadcrumb: () => (
                            <Breadcrumbs label="Breadcrumb">
                                {crumbs.map(crumb => (
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
                        // browser's socket, then each machine — the live signals in live
                        // mode (#46), the design track's workspace in mock mode.
                        connection: () => (dataMode() === 'live'
                            ? <LiveConnection />
                            : <ConnectionStrip rows={connectionRows(clientConnection(), machines.map(m => ({ id: m.id, name: m.name, online: m.online })))} />),
                        user: () => (
                            <>
                                <span data-user-avatar aria-hidden="true">WS</span>
                                <span data-user-name>Workspace<small>ws:local</small></span>
                            </>
                        )
                    }}
                >
                    {clientConnection() === 'reconnecting' ? <OfflineBanner /> : null}
                    <RouterView />
                </AppShell>
            </ThemeProvider>
        );
    };
});
