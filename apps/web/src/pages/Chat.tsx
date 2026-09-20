import { component, signal } from 'sigx';
import type { WorkdirRef } from '@agentic/core';
import { Link, useRoute } from '@sigx/router';
import { Drawer } from '@sigx/zero';
import { Button, Composer, EmptyState, NOBODY_HINT, Tag, Thread, type Mention } from '@agentic/ui';
import { Page } from '../components/Page';
import { defineTopbar, routeId } from '../components/topbar';
import { PROJECTS, agentNamed, loadChat, loadChats, mentionedIn, projectNamed, resolveAddressing, type MockChatSummary } from '../mock/workspace';
import { ChatList, MemberTiles } from './chat/ChatList';
import { ContextPanel } from './chat/ContextPanel';
import { closeContextDrawer, contextDrawer, openContextDrawer } from './chat/context-drawer';
import { dataMode } from '../data-mode';
import { chatHead, openChatSettings, toggleChatSearch } from './chat/head';
import { lookupOver } from './chat/live';
import { LiveChat } from './chat/LiveChat';
import { mockWorkdirEnvironments } from './workdir/environments';

/** "1 waiting · 1 active" — the app bar's status summary under the chat title. */
export function memberSummary(chat: Pick<MockChatSummary, 'members'>): string {
    const count = (status: string) => chat.members.filter((m) => m.status === status).length;
    const parts = [count('waiting') ? `${count('waiting')} waiting` : '', count('active') ? `${count('active')} active` : ''].filter(Boolean);
    return parts.length ? parts.join(' · ') : `${chat.members.length} ${chat.members.length === 1 ? 'member' : 'members'}`;
}

const tasksButton = () => <Button intent="icon" icon="tree" label="Tasks in this chat" class="ag-chat-tasks" onClick={openContextDrawer} />;

defineTopbar('chat', (route) => {
    const id = routeId(route);
    // Live: what the page published for THIS chat (`chat/head.ts`); mock: the workspace's view.
    const live = dataMode() === 'live';
    const head = live ? (chatHead.value?.id === id ? chatHead.value : undefined) : loadChat(id)?.chat;
    const chat = head ? { title: head.title, members: head.members } : undefined;
    const lookup = head && 'identities' in head ? lookupOver(head.identities) : undefined;
    // The project chip (#333): live from the chat's summary, mock from the sample workspace.
    const project = !head ? undefined : 'identities' in head ? head.project : head.projectId ? projectNamed(head.projectId) : undefined;
    return {
        crumb: chat?.title,
        // The member tiles at 16 px plus the status summary — the app bar's sub-line.
        subtitle: chat ? () => (
            <>
                <MemberTiles agentIds={chat.members.map((m) => m.agentId)} size={18} lookup={lookup} />
                <span data-chat-summary>{memberSummary(chat)}</span>
                {project ? <Link to={`/projects/${project.id}`} data-chat-project><Tag tone="live">{project.name}</Tag></Link> : null}
            </>
        ) : undefined,
        // Below 1280 the tasks button reveals the context panel; on the phone it is the one right slot.
        phoneAction: chat ? tasksButton : undefined,
        actions: () => (
            <>
                {chat ? tasksButton() : null}
                {/* Live: the page answers both (`chat/head.ts`, #152); the mock page has nothing to search or save. */}
                <Button intent="icon" icon="search" label="Search this chat" {...(live ? { onClick: toggleChatSearch } : {})} />
                <Button intent="icon" icon="settings" label="Chat settings" {...(live && chat ? { onClick: openChatSettings } : {})} />
            </>
        )
    };
});

/**
 * `/chats/:id` — chat list, thread and composer, members and tasks. In
 * `live` mode (`data-mode.ts`) the page is `LiveChat`: the Chat actor read
 * live plus one `connectSession` feed per active session (#34); otherwise
 * the transcript is the chat's mock view (`loadChat`). The composer's "To"
 * row follows the handoff rule: mentions ∩ members, else the coordinator,
 * else the single member, else nobody.
 */
export const Chat = component(() => {
    const route = useRoute();
    const chats = loadChats();
    const st = signal({ draft: '' });
    // Folders picked on the mock page: kept for the visit, like its composer.
    const folders = signal<{ value: Record<string, WorkdirRef | null> }>({ value: {} });
    const view = () => {
        const v = loadChat(String(route.params.id));
        if (!v) return v;
        const members = v.chat.members.map((m) => {
            const picked = folders.value[m.agentId];
            if (picked === undefined) return m;
            const { workdir: _old, ...rest } = m;
            return picked ? { ...rest, workdir: picked } : rest;
        });
        return { ...v, chat: { ...v.chat, members } };
    };
    const setWorkdir = (e: { readonly agentId: string; readonly ref: WorkdirRef | null }): void => { folders.value = { ...folders.value, [e.agentId]: e.ref }; };
    return () => {
        if (dataMode() === 'live') return <LiveChat id={String(route.params.id)} />;
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
        const project = v.chat.projectId ? projectNamed(v.chat.projectId) : undefined;
        return (
            <Page title={v.chat.title} page="chat" hideTitle flush>
                <ChatList chats={chats} currentId={v.chat.id} projects={PROJECTS} />
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
                <ContextPanel chat={v.chat} tasks={v.tasks} environments={mockWorkdirEnvironments.list()} project={project} onSetWorkdir={setWorkdir} />
                <Drawer.Root model={() => contextDrawer.open} placement="end" label="Members and tasks" onOpenChange={(open: boolean) => { if (!open) closeContextDrawer(); }}>
                    <Drawer.Panel>
                        <div data-context-drawer>
                            <ContextPanel chat={v.chat} tasks={v.tasks} environments={mockWorkdirEnvironments.list()} project={project} onSetWorkdir={setWorkdir} />
                        </div>
                    </Drawer.Panel>
                </Drawer.Root>
            </Page>
        );
    };
});
