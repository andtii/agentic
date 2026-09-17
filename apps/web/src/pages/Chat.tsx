import { component, signal } from 'sigx';
import { Link, useRoute } from '@sigx/router';
import { Drawer } from '@sigx/zero';
import { Button, Composer, EmptyState, NOBODY_HINT, Thread, type Mention } from '@agentic/ui';
import { Page } from '../components/Page';
import { defineTopbar, routeId } from '../components/topbar';
import { agentNamed, loadChat, loadChats, mentionedIn, resolveAddressing, type MockChatSummary } from '../mock/workspace';
import { ChatList, MemberTiles } from './chat/ChatList';
import { ContextPanel } from './chat/ContextPanel';
import { closeContextDrawer, contextDrawer, openContextDrawer } from './chat/context-drawer';

/** "1 waiting · 1 active" — the app bar's status summary under the chat title. */
export function memberSummary(chat: MockChatSummary): string {
    const count = (status: string) => chat.members.filter((m) => m.status === status).length;
    const parts = [count('waiting') ? `${count('waiting')} waiting` : '', count('active') ? `${count('active')} active` : ''].filter(Boolean);
    return parts.length ? parts.join(' · ') : `${chat.members.length} ${chat.members.length === 1 ? 'member' : 'members'}`;
}

const tasksButton = () => <Button intent="icon" icon="tree" label="Tasks in this chat" class="ag-chat-tasks" onClick={openContextDrawer} />;

defineTopbar('chat', (route) => {
    const chat = loadChat(routeId(route))?.chat;
    return {
        crumb: chat?.title,
        // The member tiles at 16 px plus the status summary — the app bar's sub-line.
        subtitle: chat ? () => (
            <>
                <MemberTiles agentIds={chat.members.map((m) => m.agentId)} size={18} />
                <span data-chat-summary>{memberSummary(chat)}</span>
            </>
        ) : undefined,
        // Below 1280 the tasks button reveals the context panel; on the phone it is the one right slot.
        phoneAction: chat ? tasksButton : undefined,
        actions: () => (
            <>
                {chat ? tasksButton() : null}
                <Button intent="icon" icon="search" label="Search this chat" />
                <Button intent="icon" icon="settings" label="Chat settings" />
            </>
        )
    };
});

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
                <Drawer.Root model={() => contextDrawer.open} placement="end" label="Members and tasks" onOpenChange={(open: boolean) => { if (!open) closeContextDrawer(); }}>
                    <Drawer.Panel>
                        <div data-context-drawer>
                            <ContextPanel chat={v.chat} tasks={v.tasks} />
                        </div>
                    </Drawer.Panel>
                </Drawer.Root>
            </Page>
        );
    };
});
