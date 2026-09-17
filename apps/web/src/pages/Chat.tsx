import { component } from 'sigx';
import { Link, useRoute } from '@sigx/router';
import { Alert, Chat as ChatRow } from '@sigx/zero-daisyui/components';
import { Stack } from '@agentic/ui';
import { Page } from '../components/Page';
import { agentById, chatById } from '../mock/data';

/** `/chats/:id` — a chat header and a few mock rows; the real transcript is a later issue. */
export const Chat = component(() => {
    const route = useRoute();
    return () => {
        const chat = chatById(String(route.params.id));
        if (!chat) {
            return (
                <Page title="Chat not found">
                    <Alert color="warning"><Alert.Title>No chat with id {String(route.params.id)}</Alert.Title></Alert>
                    <Link to="/">Back to the inbox</Link>
                </Page>
            );
        }
        const agent = agentById(chat.agentId);
        return (
            <Page title={chat.title} subtitle={`with ${agent?.name ?? 'an agent'} · updated ${chat.updatedAt}`}>
                <Stack gap="md" role="log" aria-label="Transcript">
                    <ChatRow placement="end">
                        <ChatRow.Header>You</ChatRow.Header>
                        <ChatRow.Bubble>Can you take a look at this?</ChatRow.Bubble>
                    </ChatRow>
                    <ChatRow>
                        <ChatRow.Header>{agent?.name}</ChatRow.Header>
                        <ChatRow.Bubble>{chat.preview}</ChatRow.Bubble>
                        <ChatRow.Footer>mock · {chat.updatedAt}</ChatRow.Footer>
                    </ChatRow>
                </Stack>
            </Page>
        );
    };
});
