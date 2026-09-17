import { signal } from 'sigx';

/**
 * Whether the chat's context panel (members, tasks) is open as an end
 * drawer — below 1280 px the panel leaves the grid and sits behind the
 * topbar's tasks button (`docs/design/HANDOFF.md` → "Responsive behaviour").
 *
 * Module-level on purpose: the button lives in the topbar contribution and
 * the drawer in the page, and neither renders inside the other. The state
 * is client-only interaction (server renders always start closed), so one
 * process serving many requests never leaks an open drawer between them.
 */
export const contextDrawer = signal({ open: false });

export const openContextDrawer = (): void => { contextDrawer.open = true; };
export const closeContextDrawer = (): void => { contextDrawer.open = false; };
