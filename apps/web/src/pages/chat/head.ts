import { signal } from 'sigx';
import type { MockChatMember } from '../../mock/workspace';
import type { AgentIdentity } from './live';

/**
 * What the live chat page tells the topbar (#34): the title for the
 * breadcrumb and the members for the app bar's sub-line. The topbar
 * contribution is a pure function of the route (`components/topbar.ts`)
 * and the page owns the data, so the page publishes here and the
 * contribution reads it — keyed by chat id, so a stale entry for another
 * chat is never shown. Module-level like `context-drawer.ts`: on the
 * server the SSR render of the page sets it before the App reads it.
 */
export const chatHead = signal<{ value: { id: string; title: string; members: MockChatMember[]; identities: Record<string, AgentIdentity> } | null }>({ value: null });

/** The "New chat" request: the topbar's button raises it, the page's dialog answers it (client-only interaction, like `context-drawer.ts`). */
export const newChatRequest = signal({ open: false });
export const openNewChat = (): void => { newChatRequest.open = true; };
export const closeNewChat = (): void => { newChatRequest.open = false; };
