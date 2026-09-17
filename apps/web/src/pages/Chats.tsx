import { component } from 'sigx';
import { Button } from '@agentic/ui';
import { Page } from '../components/Page';
import { defineTopbar } from '../components/topbar';
import { loadChats } from '../mock/workspace';
import { ChatList } from './chat/ChatList';

defineTopbar('chats', () => ({ actions: () => <Button intent="primary" icon="plus">New chat</Button> }));

/** `/chats` — the chat list at full width (the mobile issue reuses it). */
export const Chats = component(() => {
    const chats = loadChats();
    return () => (
        <Page title="Chats" page="chats" hideTitle>
            <ChatList chats={chats} wide />
        </Page>
    );
});
