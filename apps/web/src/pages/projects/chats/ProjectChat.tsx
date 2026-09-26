/**
 * `/projects/:id/chats/:chatId` (#929; `docs/design/projects/boards/PMChat.dc.html`): a project's chat opens inside the
 * project — the project's menu stays expanded with Chats active, the crumbs read `Projects › <project> › Chats ›
 * <chat>`, and the page is the chat's thread, composer and context panel without the global chat list. The chat itself
 * is the `/chats/:id` page's (`ChatScreen`: the mock view, or `LiveChat` live), visiting managers included; a chat
 * that is not this project's replaces the URL with its own address (`chat/href.ts`).
 */
import { component } from 'sigx';
import { useRoute } from '@sigx/router';
import { defineTopbar } from '../../../components/topbar';
import { ChatScreen, chatTopbar } from '../../Chat';
import { projectChatHref } from '../../chat/href';
import { projectTrail } from '../layout/trail';
import type { ProjectPageProps } from '../layout/types';

/** The route's chat id. */
const chatIdOf = (route: { readonly params: Record<string, string | string[] | undefined> }): string => String(route.params.chatId ?? '');

defineTopbar('project-chat', (route) => {
    const chatId = chatIdOf(route);
    const projectId = String(route.params.id ?? '');
    const chat = chatTopbar(chatId);
    return {
        ...chat,
        trail: projectTrail(route, { label: 'Chats', href: `/projects/${projectId}/chats` }, { label: chat.crumb ?? chatId, href: projectChatHref(projectId, chatId) })
    };
});

export const ProjectChat = component<ProjectPageProps>(({ props }) => {
    const route = useRoute();
    // Keyed by the chat: another chat opened from here mounts a fresh page (its draft, feeds and mention are per chat).
    return () => {
        const chatId = chatIdOf(route);
        return <ChatScreen key={chatId} id={chatId} projectId={props.project.id} />;
    };
}, { name: 'ProjectChat' });
