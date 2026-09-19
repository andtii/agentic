import { component } from 'sigx';
import { Button } from '@agentic/ui';
import { Page } from '../components/Page';
import { defineTopbar } from '../components/topbar';
import { dataMode } from '../data-mode';
import { AGENTS, loadChats } from '../mock/workspace';
import { ChatList } from './chat/ChatList';
import { closeNewChat, newChatRequest, openNewChat } from './chat/head';
import { LiveChats } from './chat/LiveChats';
import { NewChatDialog } from './chat/NewChatDialog';
import { mockWorkdirEnvironments } from './workdir/environments';

defineTopbar('chats', () => ({ actions: () => <Button intent="primary" icon="plus" onClick={openNewChat}>New chat</Button> }));

/**
 * `/chats` — the chat list at full width (the mobile issue reuses it); the workspace's chats on the platform (#34).
 * On mock data the New chat dialog shows the sample agents and their accounts' limits (#315); creating closes it.
 */
export const Chats = component(() => {
    const chats = loadChats();
    return () => (dataMode() === 'live' ? <LiveChats /> : (
        <Page title="Chats" page="chats" hideTitle>
            <ChatList chats={chats} wide />
            <NewChatDialog model={() => newChatRequest.open} agents={AGENTS} environments={mockWorkdirEnvironments.list()} onCancel={closeNewChat} onCreate={closeNewChat} />
        </Page>
    ));
});
