import { component, useData, useHead, type JSXElement } from 'sigx';
import { Link, RouterView, useRoute } from '@sigx/router';
import { ThemeProvider, themeInitScript } from '@sigx/zero';
import { Breadcrumbs } from '@sigx/zero-daisyui/components';
import { AppShell, Button, ConnectionStrip, connectionRows, OfflineBanner } from '@agentic/ui';
import { NAV_GROUPS } from './nav';
import { backOf, titleOf, trailFor } from './crumbs';
import { machines } from './mock/data';
import { topbarFor } from './components/topbar';
import { clientConnection, LiveConnection } from './components/status';
import { dataMode } from './data-mode';
import { useViewer } from './actors/defs';
import { signInOptions } from './api/sign-in.server';
import { DEV_LOGIN_PATH } from './auth/dev-login';
import { useNeedsSource } from './pages/inbox';

/**
 * The sidebar foot in live mode (#143): the signed-in workspace, or — for
 * nobody — the doors this deployment has open. Its own component so the
 * async reads (`whoami`, `signInOptions`) resolve into ITS render: the server
 * renderer re-renders the component that owns a pending read, not a slot
 * closure a parent handed down.
 */
const UserFoot = component(() => {
    const viewer = useViewer()();
    const doors = useData(signInOptions);
    return () => {
        if (!viewer.pending && !viewer.workspaceId) {
            const open = doors.value;
            return (
                <span data-sign-in="">
                    {open?.github ? <a href="/auth/login" data-sign-in-github="">Sign in with GitHub</a> : null}
                    {open?.devLogin ? <a href={DEV_LOGIN_PATH} data-sign-in-dev="">Dev login</a> : null}
                    {!open?.github && !open?.devLogin ? <span data-sign-in-none="">Signed out</span> : null}
                </span>
            );
        }
        const ws = viewer.workspaceId ?? '…';
        return (
            <>
                <span data-user-avatar aria-hidden="true">{initials(ws)}</span>
                <span data-user-name>Workspace<small>{ws}</small></span>
                {viewer.workspaceId ? (
                    <form data-user-signout method="post" action="/auth/logout" style="margin-inline-start:auto">
                        <Button type="submit">Sign out</Button>
                    </form>
                ) : null}
            </>
        );
    };
}, { name: 'UserFoot' });

/** The design track's user, what mock mode shows. */
const mockUserFoot = (): JSXElement => (
    <>
        <span data-user-avatar aria-hidden="true">WS</span>
        <span data-user-name>Workspace<small>ws:local</small></span>
    </>
);

/** Two letters for the avatar: `dev_ada` → `AD`, `gh_123` → `12`, `ws:local` → `WS`. */
function initials(id: string): string {
    const tail = id.replace(/^(dev_|gh_)/, '');
    return (tail.slice(0, 2) || 'WS').toUpperCase();
}

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
    // The Home badge is "Needs you" itself (#151): the rows Home lists, read from the same source.
    const needs = useNeedsSource()().useRows();

    return () => {
        const top = topbar();
        const crumbs = trail();
        return (
            <ThemeProvider>
                <AppShell
                    brand="agentic"
                    groups={NAV_GROUPS(needs().length)}
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
                        // Live mode: who is signed in, or the doors open to a visitor (#143); mock mode keeps the design track's user.
                        user: () => (dataMode() === 'live' ? <UserFoot /> : mockUserFoot())
                    }}
                >
                    {clientConnection() === 'reconnecting' ? <OfflineBanner /> : null}
                    <RouterView />
                </AppShell>
            </ThemeProvider>
        );
    };
});
