/**
 * `/chats/new?env=&path=&origin=` (#336, architecture §10): the deep link
 * `agentic-daemon open` sends the browser to. It is the chats page with the
 * New chat dialog opened on a prefill — the folder the chat starts in and
 * the repo it is a checkout of — so the dialog preselects the project that
 * names that origin, or offers to create one. Without a usable query it is
 * the plain dialog. Whatever the dialog does, this URL is replaced (the
 * new chat, the project form, or the list), so the link never re-fires on
 * back or reload.
 */
import { component, onMounted, onUnmounted, watch } from 'sigx';
import { useRoute, useRouter } from '@sigx/router';
import { defineTopbar } from '../../components/topbar';
import { Chats } from '../Chats';
import { closeNewChat, newChatRequest, openNewChat, openNewChatWith } from './head';
import { newChatPrefillOf, newChatProjectOf } from './new-chat-prefill';

defineTopbar('chat-new', () => ({ crumb: 'New chat' }));

export const NewChatEntry = component(() => {
    const route = useRoute();
    const router = useRouter();
    // Read once: the query is the request, and it is replaced as soon as the dialog answers.
    const prefill = newChatPrefillOf(route.query);
    // Opened from a project's pages (#929): closed without a chat, it goes back to that project's chats.
    const project = newChatProjectOf(route.query);
    onMounted(() => {
        if (prefill) openNewChatWith(prefill);
        else openNewChat();
    });
    // Closed without leaving (cancel, or a create that only closes): back to the list, this URL replaced.
    watch(
        () => newChatRequest.open,
        (open, prev) => {
            if (prev && !open && route.name === 'chat-new') void router.replace(project ? `/projects/${encodeURIComponent(project)}/chats` : '/chats');
        }
    );
    onUnmounted(closeNewChat);
    return () => <Chats />;
});
