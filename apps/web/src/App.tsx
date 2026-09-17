import { component, useHead } from 'sigx';
import { Link, RouterView, useRoute } from '@sigx/router';
import { ThemeProvider, themeInitScript } from '@sigx/zero';
import { AppShell } from '@agentic/ui';
import { NAV } from './nav';

/**
 * The root component: the responsive shell around the routed page.
 *
 * `themeInitScript` restores a persisted explicit theme before first paint;
 * `useHead` puts it into the server-rendered <head> (priority -1: ahead of
 * everything else). `ThemeProvider` gives server renders a per-request theme
 * controller — `useTheme()` throws on the server without one.
 */
export const App = component(() => {
    useHead({
        titleTemplate: '%s · agentic',
        script: [{ innerHTML: themeInitScript() }],
        priority: -1
    });
    const route = useRoute();

    return () => (
        <ThemeProvider>
            <AppShell
                brand="agentic"
                items={NAV}
                currentPath={route.path}
                slots={{
                    link: ({ item }) => <Link to={item.href}>{item.label}</Link>
                }}
            >
                <RouterView />
            </AppShell>
        </ThemeProvider>
    );
});
