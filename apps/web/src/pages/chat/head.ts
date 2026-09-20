import { signal } from 'sigx';
import type { MockChatMember } from '../../mock/workspace';
import type { AgentIdentity } from './live';
import type { NewChatPrefill } from './new-chat-prefill';

/**
 * What the live chat page tells the topbar (#34): the title for the
 * breadcrumb and the members for the app bar's sub-line. The topbar
 * contribution is a pure function of the route (`components/topbar.ts`)
 * and the page owns the data, so the page publishes here and the
 * contribution reads it — keyed by chat id, so a stale entry for another
 * chat is never shown. Module-level like `context-drawer.ts`: on the
 * server the SSR render of the page sets it before the App reads it.
 */
export const chatHead = signal<{ value: { id: string; title: string; members: MockChatMember[]; identities: Record<string, AgentIdentity>; project?: { id: string; name: string } } | null }>({ value: null });

/**
 * The "New chat" request: the topbar's button raises it, the page's dialog answers it (client-only interaction, like
 * `context-drawer.ts`). `/chats/new?env=&path=&origin=` (#336, `agentic-daemon open`) raises it with a prefill: the
 * folder the chat starts in and the repo it is a checkout of.
 */
export const newChatRequest = signal<{ open: boolean; prefill: NewChatPrefill | null }>({ open: false, prefill: null });
export const openNewChat = (): void => {
    newChatRequest.prefill = null;
    newChatRequest.open = true;
};
export const openNewChatWith = (prefill: NewChatPrefill): void => {
    newChatRequest.prefill = prefill;
    newChatRequest.open = true;
};
export const closeNewChat = (): void => {
    newChatRequest.open = false;
    newChatRequest.prefill = null;
};

/** "Search this chat" and "Chat settings" (#152): the topbar's buttons raise them, the live page answers — the same seam as `newChatRequest`. */
export const chatSearchRequest = signal({ open: false });
export const toggleChatSearch = (): void => { chatSearchRequest.open = !chatSearchRequest.open; };
export const closeChatSearch = (): void => { chatSearchRequest.open = false; };
export const chatSettingsRequest = signal({ open: false });
export const openChatSettings = (): void => { chatSettingsRequest.open = true; };
export const closeChatSettings = (): void => { chatSettingsRequest.open = false; };
