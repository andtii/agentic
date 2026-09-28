import { component, useData, useHead, type JSXElement } from 'sigx';
import { Link, RouterView, useRoute, useRouter } from '@sigx/router';
import { Avatar, Breadcrumbs, themeInitScript, ThemeProvider } from '@sigx/zero';
import { AppShell, Button, ConnectionStrip, connectionRows, OfflineBanner, type NavGroup } from '@agentic/ui';
import { NAV_GROUPS } from './nav';
import { backOf, titleOf, trailFor } from './crumbs';
import { machines } from './mock/data';
import { topbarFor } from './components/topbar';
import { clientConnection, LiveConnection } from './components/status';
import { dataMode } from './data-mode';
import { useActorDefs, useViewer } from './actors/defs';
import { signInOptions } from './api/sign-in.server';
import { DEV_LOGIN_PATH } from './auth/dev-login';
import { localLoginHref } from './auth/sign-in';
import { pullsNeedingYou, useNeedsSource, type PullNeeds } from './pages/inbox';
import { mockPullNeeds } from './pages/projects/work/pull/links';
import { PullsFeed, createWorkspacePulls, livePullNeeds, type WorkspacePulls } from './pages/projects/work/pull/LivePulls';
import { useDesktopNotifications } from './desktop';
import { projectMenuFor, projectMenuSource } from './pages/projects/layout/menu';
import { openProjectPicker } from './pages/projects/layout/ProjectPicker';

/**
 * The signed-in person's mark in the sidebar foot: zero's `Avatar` as a
 * circle (a person, never an agent's square), 28 px through the avatar
 * patch's `data-tile`, the monogram as its fallback. Decorative: the name is
 * written next to it.
 */
const userAvatar = (monogram: string): JSXElement => (
    <Avatar.Root axes={{ shape: 'circle' }} data-tile={28} data-user-avatar="" aria-hidden="true">
        <Avatar.Fallback>{monogram}</Avatar.Fallback>
    </Avatar.Root>
);

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
    const route = useRoute();
    return () => {
        if (!viewer.pending && !viewer.workspaceId) {
            const open = doors.value;
            const any = open?.github || open?.devLogin || open?.localPassphrase;
            return (
                <span data-sign-in="">
                    {open?.localPassphrase ? (
                        <a href={localLoginHref(route.fullPath)} data-sign-in-passphrase="">
                            Sign in with passphrase
                        </a>
                    ) : null}
                    {open?.github ? <a href="/auth/login" data-sign-in-github="">Sign in with GitHub</a> : null}
                    {open?.devLogin ? <a href={DEV_LOGIN_PATH} data-sign-in-dev="">Dev login</a> : null}
                    {/* The claim link is a secret: say where it is, never show it (#1016). */}
                    {open?.localUnclaimed ? (
                        <span data-sign-in-unclaimed="" style="color:var(--ag-text-dim);font-size:var(--text-sm)">
                            This node is unclaimed. Open the claim link <code>agentic start</code> printed.
                        </span>
                    ) : null}
                    {!any && !open?.localUnclaimed ? <span data-sign-in-none="">Signed out</span> : null}
                </span>
            );
        }
        const ws = viewer.workspaceId ?? '…';
        return (
            <>
                {userAvatar(initials(ws))}
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
        {userAvatar('WS')}
        <span data-user-name>Workspace<small>ws:local</small></span>
    </>
);

/** Two letters for the avatar: `dev_ada` → `AD`, `gh_123` → `12`, `ws:local` → `WS`. */
function initials(id: string): string {
    const tail = id.replace(/^(dev_|gh_)/, '');
    return (tail.slice(0, 2) || 'WS').toUpperCase();
}

/**
 * The sidebar's groups with the open project's switcher (#794): the entry carrying the project's menu (`Projects`,
 * #725) gets the project's name and id, which the shell draws as the "Switch project" button over the menu (#727).
 * Off a project route there is no menu, so no switcher.
 */
function withSwitcher(groups: readonly NavGroup[], route: Parameters<typeof projectMenuSource>[0]): readonly NavGroup[] {
    const src = projectMenuSource(route);
    if (!src) return groups;
    return groups.map(group => ({
        ...group,
        items: group.items.map(item => (item.children ? { ...item, switcher: { name: src.name, id: src.id } } : item))
    }));
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
/**
 * The pull requests the shell's Home badge counts (#967): live, every Git project's Pulls actor through a
 * `PullsFeed` the shell mounts (`feed`); on mock data the Work fixtures (`mockPullNeeds`), as Home reads them.
 */
export function useShellPulls(): { readonly needs: PullNeeds; readonly feed?: WorkspacePulls } {
    if (dataMode() !== 'live') return { needs: mockPullNeeds() };
    const defs = useActorDefs();
    const viewer = useViewer()();
    const feed = createWorkspacePulls();
    return { needs: livePullNeeds(feed, defs, () => viewer.workspaceId, () => viewer.login), feed };
}

/** Routes that run edge to edge: the chat, and a session's views under their session bar (#564). */
const FLUSH_ROUTES = new Set(['chat', 'project-chat', 'session', 'session-changes', 'session-files']);
/** The desktop app's quick-ask window (#849): the page alone, no shell around it. */
const BARE_ROUTE = 'quick';

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
    const router = useRouter();
    // The nav's anchors carry zero's NavList.Link parts, which the router's Link cannot take, so they
    // navigate through the router as Link does: a plain left click, no modifier, not already handled.
    const follow = (e: MouseEvent, to: string): void => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        void router.push(to);
    };
    const topbar = () => topbarFor(route);
    const trail = () => trailFor(route, topbar());
    // The Home badge is "Needs you" itself (#151): the rows Home lists, read from the same source — and, since
    // Home lists them (#865), the pull requests whose move is yours (#967), so the badge equals Home's "N open".
    const needs = useNeedsSource()().useRows();
    const shellPulls = useShellPulls();
    const pulls = shellPulls.needs.usePulls();
    const badge = (): number => needs().length + pullsNeedingYou(pulls(), shellPulls.needs.me).length;
    // Inside the desktop app (#845): new Inbox notifications become native ones, and the badge follows Home's.
    // Not from the quick-ask window (#849): the main window's page already does it.
    if (dataMode() === 'live' && route.name !== BARE_ROUTE) useDesktopNotifications(badge);

    return () => {
        if (route.name === BARE_ROUTE) return <ThemeProvider><RouterView /></ThemeProvider>;
        const top = topbar();
        const crumbs = trail();
        return (
            <ThemeProvider>
                <AppShell
                    brand="agentic"
                    groups={withSwitcher(NAV_GROUPS(badge(), projectMenuFor(route)), route)}
                    currentPath={route.path}
                    flush={FLUSH_ROUTES.has(String(route.name ?? ''))}
                    title={titleOf(crumbs)}
                    back={backOf(crumbs)}
                    // The switcher over a project's menu (#727) opens the project picker `ProjectLayout` mounts (#728).
                    onSwitch={openProjectPicker}
                    slots={{
                        link: ({ item, icon, meta, props }) => <a {...props} onClick={(e: MouseEvent) => { props.onClick?.(e); follow(e, item.href); }}>{icon}{item.label}{meta}</a>,
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
                    {shellPulls.feed ? <PullsFeed feed={shellPulls.feed} /> : null}
                    {clientConnection() === 'reconnecting' ? <OfflineBanner /> : null}
                    <RouterView />
                </AppShell>
            </ThemeProvider>
        );
    };
});
