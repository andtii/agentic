/**
 * The `ai-shell` scope — the regions `AppShell` stamps around zero's
 * `Drawer`, `Navbar` and `NavList` (#589): the sidebar's brand, navigation
 * and foot, and the app bar and content column beside it. Declared with
 * zero's public `defineAnatomy`, pure data, so the fragment entry lists the
 * scope and the component writes `aiShellAnatomy.scope` instead of a
 * literal. No recipe: `shell.css` lays the regions out; the drawer, the bar
 * and the navigation are the design system's.
 */
import { defineAnatomy } from '@sigx/zero/anatomy';

export const aiShellAnatomy = defineAnatomy('ai-shell', {
    root: { element: 'div' },
    /** The sheet's head on a phone: the brand beside the close button. */
    'drawer-head': { element: 'div', parent: 'root' },
    brand: { element: 'span', parent: 'root' },
    'brand-mark': { element: 'span', parent: 'brand', tokens: ['color', 'text'] },
    'brand-name': { element: 'span', parent: 'brand', tokens: ['text'] },
    nav: { element: 'div', parent: 'root' },
    'sidebar-spacer': { element: 'div', parent: 'root' },
    connection: { element: 'div', parent: 'root' },
    user: { element: 'div', parent: 'root' },
    /** The content column: the app bar over `main`. */
    body: { element: 'div', parent: 'root' },
    bar: { element: 'div', parent: 'body' },
    back: { element: 'span', parent: 'bar' },
    breadcrumb: { element: 'div', parent: 'bar' },
    title: { element: 'div', parent: 'bar' },
    'title-text': { element: 'span', parent: 'title', tokens: ['text'] },
    subtitle: { element: 'span', parent: 'title', tokens: ['color', 'text'] },
    actions: { element: 'div', parent: 'bar' },
    'phone-action': { element: 'div', parent: 'bar' },
    main: { element: 'main', parent: 'body' }
});

/** The `ai-shell` scope name, for the component's `data-scope`. */
export const SHELL_SCOPE = aiShellAnatomy.scope;
