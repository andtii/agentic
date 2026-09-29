import { signal } from 'sigx';
import { defineWebStore, forward } from '../../stores/define';
import type { MockChatMember } from '../../mock/workspace';
import type { AgentIdentity } from './live';
import type { NewChatPrefill } from './new-chat-prefill';

export interface ChatHead {
    readonly id: string;
    readonly title: string;
    readonly members: MockChatMember[];
    readonly identities: Record<string, AgentIdentity>;
    readonly project?: { id: string; name: string };
    readonly machine?: { id: string; name: string; online: boolean };
}

/**
 * The chat page's shared state (#1124: a web store, one per app — `stores/define.ts`):
 *
 * - `head` — what the live chat page tells the topbar (#34): the title for the breadcrumb and the members for the
 *   app bar's sub-line. The topbar contribution is a pure function of the route (`components/topbar.ts`) and the
 *   page owns the data, so the page publishes here and the contribution reads it — keyed by chat id, so a stale
 *   entry for another chat is never shown. On the server the SSR render of the page sets it before the App reads it.
 * - `newChat` — the "New chat" request: the topbar's button raises it, the page's dialog answers it.
 *   `/chats/new?env=&path=&origin=` (#336, `agentic-daemon open`) raises it with a prefill: the folder the chat
 *   starts in and the repo it is a checkout of.
 * - `search`, `settings` — "Search this chat" and "Chat settings" (#152), the same seam.
 */
export const useChatHeadStore = defineWebStore('chat-head', () => {
    const head = signal<{ value: ChatHead | null }>({ value: null });
    const newChat = signal<{ open: boolean; prefill: NewChatPrefill | null }>({ open: false, prefill: null });
    const search = signal({ open: false });
    const settings = signal({ open: false });
    return {
        head,
        newChat,
        search,
        settings,
        openNewChat(): void {
            newChat.prefill = null;
            newChat.open = true;
        },
        openNewChatWith(prefill: NewChatPrefill): void {
            newChat.prefill = prefill;
            newChat.open = true;
        },
        closeNewChat(): void {
            newChat.open = false;
            newChat.prefill = null;
        },
        toggleChatSearch(): void { search.open = !search.open; },
        closeChatSearch(): void { search.open = false; },
        openChatSettings(): void { settings.open = true; },
        closeChatSettings(): void { settings.open = false; }
    };
});

export const chatHead = forward(() => useChatHeadStore().head);
export const newChatRequest = forward(() => useChatHeadStore().newChat);
export const chatSearchRequest = forward(() => useChatHeadStore().search);
export const chatSettingsRequest = forward(() => useChatHeadStore().settings);
export const openNewChat = (): void => useChatHeadStore().openNewChat();
export const openNewChatWith = (prefill: NewChatPrefill): void => useChatHeadStore().openNewChatWith(prefill);
export const closeNewChat = (): void => useChatHeadStore().closeNewChat();
export const toggleChatSearch = (): void => useChatHeadStore().toggleChatSearch();
export const closeChatSearch = (): void => useChatHeadStore().closeChatSearch();
export const openChatSettings = (): void => useChatHeadStore().openChatSettings();
export const closeChatSettings = (): void => useChatHeadStore().closeChatSettings();
