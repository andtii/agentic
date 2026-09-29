import { signal } from 'sigx';
import { defineWebStore, forward } from '../../stores/define';

/**
 * Whether the chat's context panel (members, tasks) is open as an end drawer — below 1280 px the panel leaves
 * the grid and sits behind the topbar's tasks button (`docs/design/HANDOFF.md` → "Responsive behaviour").
 *
 * Shared on purpose: the button lives in the topbar contribution and the drawer in the page, and neither renders
 * inside the other. A web store, one per app (#1124, `stores/define.ts`), so a server render always starts closed.
 */
export const useContextDrawerStore = defineWebStore('context-drawer', () => {
    const drawer = signal({ open: false });
    return {
        drawer,
        openContextDrawer(): void { drawer.open = true; },
        closeContextDrawer(): void { drawer.open = false; }
    };
});

export const contextDrawer = forward(() => useContextDrawerStore().drawer);
export const openContextDrawer = (): void => useContextDrawerStore().openContextDrawer();
export const closeContextDrawer = (): void => useContextDrawerStore().closeContextDrawer();
