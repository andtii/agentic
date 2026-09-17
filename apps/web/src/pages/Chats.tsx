import { component } from 'sigx';
import { Button } from '@agentic/ui';
import { Page } from '../components/Page';
import { defineTopbar } from '../components/topbar';
import { dataMode } from '../data-mode';
import { loadChats } from '../mock/workspace';
import { ChatList } from './chat/ChatList';
import { openNewChat } from './chat/head';
import { LiveChats } from './chat/LiveChats';

// The button opens the live page's dialog; the mock page mounts none, so there it stays the artboard's inert control.
defineTopbar('chats', () => ({ actions: () => <Button intent="primary" icon="plus" onClick={dataMode() === 'live' ? openNewChat : undefined}>New chat</Button> }));

/** `/chats` — the chat list at full width (the mobile issue reuses it); the workspace's chats on the platform (#34). */
export const Chats = component(() => {
    const chats = loadChats();
    return () => (dataMode() === 'live' ? <LiveChats /> : (
        <Page title="Chats" page="chats" hideTitle>
            <ChatList chats={chats} wide />
        </Page>
    ));
});
