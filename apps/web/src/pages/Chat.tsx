import { component, signal } from 'sigx';
import { Link, useRoute } from '@sigx/router';
import { Button, Composer, EmptyState, NOBODY_HINT, Thread, type Mention } from '@agentic/ui';
import { Page } from '../components/Page';
import { defineTopbar, routeId } from '../components/topbar';
import { agentNamed, loadChat, loadChats, mentionedIn, resolveAddressing } from '../mock/workspace';
import { ChatList } from './chat/ChatList';
import { ContextPanel } from './chat/ContextPanel';

defineTopbar('chat', (route) => ({
    crumb: loadChat(routeId(route))?.chat.title,
    actions: () => (
        <>
            <Button intent="icon" icon="search" label="Search this chat" />
            <Button intent="icon" icon="settings" label="Chat settings" />
        </>
    )
}));

/**
 * `/chats/:id` — chat list, thread and composer, members and tasks. The
 * transcript is the chat's mock view (`loadChat`); #34 swaps it for the
 * Chat actor plus `Session.tail` per active session. The composer's "To"
 * row follows the handoff rule: mentions ∩ members, else the coordinator,
 * else the single member, else nobody.
 */
export const Chat = component(() => {
    const route = useRoute();
    const chats = loadChats();
    const st = signal({ draft: '' });
    const view = () => loadChat(String(route.params.id));
    return () => {
        const v = view();
        if (!v) {
            return (
                <Page title="Chat not found">
                    <EmptyState variant="generic" title="No chat with that id" caption={`Nothing is called ${String(route.params.id)}.`} slots={{ actions: () => <Link to="/chats">Back to chats</Link> }} />
                </Page>
            );
        }
        const addressing = resolveAddressing(v.chat.members, mentionedIn(st.draft, v.chat.members));
        const mentions: Mention[] = v.chat.members.map((m) => {
            const a = agentNamed(m.agentId);
            return { id: a.name, label: a.name, description: a.role };
        });
        const empty = v.transcript.messages.length === 0;
        return (
            <Page title={v.chat.title} page="chat" hideTitle flush>
                <ChatList chats={chats} currentId={v.chat.id} />
                <section data-chat-main aria-label="Conversation">
                    {empty
                        ? <div data-chat-empty><EmptyState variant="chat" /></div>
                        : (
                            <Thread
                                transcript={v.transcript}
                                describe={(m) => v.authors[m.id]}
                                toolMeta={(p) => v.toolMeta[p.callId]}
                                describeRequest={(r) => v.approvals[r.requestId]}
                                logHref={v.logHref}
                                onRespond={() => undefined}
                            />
                        )}
                    <div data-chat-composer onInput={(e: Event) => { st.draft = (e.target as HTMLTextAreaElement).value ?? ''; }}>
                        <Composer
                            recipients={addressing.recipients}
                            hint={addressing.recipients.length ? addressing.hint : NOBODY_HINT}
                            mentions={mentions}
                            placeholder="Message the chat. @ to address an agent, otherwise the coordinator answers."
                            onSend={() => { st.draft = ''; }}
                        />
                    </div>
                </section>
                <ContextPanel chat={v.chat} tasks={v.tasks} />
            </Page>
        );
    };
});
