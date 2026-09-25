import { component } from 'sigx';
import { useRouter } from '@sigx/router';
import { Button } from '@agentic/ui';
import { Page } from '../components/Page';
import { defineTopbar } from '../components/topbar';
import { dataMode } from '../data-mode';
import { AGENTS, LAST_PROJECT_ID, PROJECTS, loadChats } from '../mock/workspace';
import { ChatList } from './chat/ChatList';
import { closeNewChat, newChatRequest, openNewChat } from './chat/head';
import { LiveChats } from './chat/LiveChats';
import { NewChatDialog } from './chat/NewChatDialog';
import { newProjectLink } from './chat/new-chat-prefill';
import { mockWorkdirEnvironments } from './workdir/environments';

defineTopbar('chats', () => ({ actions: () => <Button intent="primary" icon="plus" onClick={openNewChat}>New chat</Button> }));

/**
 * `/chats` — the chat list at full width (the mobile issue reuses it); the workspace's chats on the platform (#34).
 * On mock data the New chat dialog shows the sample agents and their accounts' limits (#315); creating closes it.
 * Opened from a folder (#336, `/chats/new?…`) it carries the prefill; "Create project from this folder" goes to the form.
 */
export const Chats = component(() => {
    const chats = loadChats();
    const router = useRouter();
    return () => (dataMode() === 'live' ? <LiveChats /> : (
        <Page title="Chats" page="chats" hideTitle>
            <ChatList chats={chats} wide projects={PROJECTS} />
            <NewChatDialog
                model={() => newChatRequest.open}
                agents={AGENTS}
                environments={mockWorkdirEnvironments.list()}
                machines={mockWorkdirEnvironments.machines()}
                projects={PROJECTS}
                lastProjectId={LAST_PROJECT_ID}
                {...(newChatRequest.prefill ? { prefill: newChatRequest.prefill } : {})}
                onCancel={closeNewChat}
                onCreate={closeNewChat}
                onCreateProject={(p) => { void router.replace(newProjectLink(p)); }}
            />
        </Page>
    ));
});
