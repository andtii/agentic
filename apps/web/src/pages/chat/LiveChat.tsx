/**
 * `/chats/:id` on the platform (#34): the Chat actor read live
 * (`get` for members, coordinator and active sessions; `history` for the
 * entries), one session feed per active session tailed through
 * `connectSession`, the composer posting to `Chat.post` and starting the
 * activated agents' tasks through the router. Same columns, same
 * components as the mock page — only the data source differs.
 */
import { component, effect, onMounted, onUnmounted, signal, type JSXElement } from 'sigx';
import { Link, useRouter } from '@sigx/router';
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
import { Drawer } from '@sigx/zero';
import { createId, type AgentId, type ChatId, type TaskId } from '@agentic/core';
import type { Decision } from '@sigx/ai-agent';
import { Composer, EmptyState, NOBODY_HINT, Thread, type Mention, type MessageAuthor } from '@agentic/ui';
import { Page } from '../../components/Page';
import { FailureNotice } from '../../components/status';
import { useActorDefs, useViewer } from '../../actors/defs';
import { chatKeyOf, routingKeyOf, sessionKeyOf, taskKeyOf } from '../../actors/keys';
import { resolveAddressing, type MockChatSummary, type MockTaskRow } from '../../mock/workspace';
import { ContextPanel } from './ContextPanel';
import { closeContextDrawer, contextDrawer } from './context-drawer';
import { useAgentDirectory } from './directory';
import { openFeed, type FeedHandle } from './feeds';
import { chatHead, closeNewChat, newChatRequest, openNewChat } from './head';
import { chatFailure, chatTitle, chatTranscript, composeTranscript, entryTranscript, membersOf, mentionsIn, runActivation, type SessionActorClient } from './live';
import { LiveChatList, createChatWith } from './LiveChats';
import { NewChatDialog } from './NewChatDialog';

/** Entries read per chat — the Chat actor's page maximum; older ones are a follow-up ("Load earlier"). */
export const HISTORY_LIMIT = 200;

export const LiveChat = component<{ id: string }>(({ props }) => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const router = useRouter();
    const directory = useAgentDirectory(defs, viewer);
    const key = (): string | null => (viewer.workspaceId ? chatKeyOf(viewer.workspaceId, props.id) : null);

    const summary = useActorState(defs.Chat, () => { const k = key(); return k && ([k, 'get'] as const); }, { live: true });
    const history = useActorState(defs.Chat, () => { const k = key(); return k && ([k, 'history', null, HISTORY_LIMIT] as const); }, { live: true });

    const st = signal({ draft: '', error: '', sending: false, recovering: false });
    const transcript = signal(chatTranscript('chat'));
    const authors = signal<{ value: Record<string, MessageAuthor> }>({ value: {} });
    const feeds = signal<{ list: FeedHandle[] }>({ list: [] });

    const session = (sessionId: string): SessionActorClient => actor(defs.Session, sessionKeyOf(viewer.workspaceId!, sessionId)) as unknown as SessionActorClient;
    const fail = (e: unknown): void => { st.error = e instanceof Error ? e.message : String(e); };

    // The feeds follow `activeSessions`: opened on the client only (a server render tails nothing), closed when a session leaves the chat or the page unmounts.
    onMounted(() => {
        const stop = effect(() => {
            const active = summary.value?.activeSessions ?? {};
            const wanted = new Map(Object.entries(active).map(([agentId, sessionId]) => [sessionId as string, agentId]));
            const keep = feeds.list.filter((f) => wanted.has(f.sessionId));
            for (const f of feeds.list) if (!wanted.has(f.sessionId)) f.disconnect();
            for (const [sessionId, agentId] of wanted) {
                if (!keep.some((f) => f.sessionId === sessionId)) keep.push(openFeed(session(sessionId), sessionId, agentId, fail));
            }
            if (keep.length !== feeds.list.length || keep.some((f, i) => feeds.list[i] !== f)) feeds.list = keep;
        });
        onUnmounted(() => {
            stop();
            for (const f of feeds.list) f.disconnect();
        });
    });

    // The thread's one transcript: the chat's rows plus every feed's in-flight rows, recomposed as either side changes.
    const stopCompose = effect(() => {
        const entries = entryTranscript(history.value?.entries ?? [], directory.lookup);
        authors.value = composeTranscript(transcript, entries, feeds.list, directory.lookup);
    });
    onUnmounted(stopCompose);

    // The topbar reads the title and members from here.
    const stopHead = effect(() => {
        const s = summary.value;
        const members = s ? membersOf(s) : [];
        const identities = Object.fromEntries(members.map((m) => [m.agentId, directory.lookup(m.agentId)]));
        chatHead.value = { id: props.id, title: s ? chatTitle(members, directory.lookup, s.title) : props.id, members, identities };
    });
    onUnmounted(stopHead);

    const send = async (text: string): Promise<void> => {
        const ws = viewer.workspaceId;
        const s = summary.value;
        if (!ws || !s || st.sending) return;
        const k = chatKeyOf(ws, props.id);
        const members = membersOf(s);
        st.sending = true;
        st.error = '';
        try {
            await runActivation(
                {
                    post: (input, mentions) => actor(defs.Chat, k).post(input, mentions),
                    createTask: (id, contract, owner) => actor(defs.TaskActor, taskKeyOf(ws, id)).create(contract, { owner }),
                    run: (taskId) => actor(defs.Routing, routingKeyOf(ws)).run(taskId),
                    newTaskId: () => createId('task') as TaskId
                },
                { chatId: props.id as ChatId, text, mentions: mentionsIn(text, members, directory.lookup), summary: s, entries: history.value?.entries ?? [], lookup: directory.lookup }
            );
            st.draft = '';
        } catch (e) {
            fail(e);
        } finally {
            st.sending = false;
        }
    };

    /** "Resume" on an interrupted turn (OPS-05): the router re-prompts the session over its intact transcript and follows the new turn. */
    const resume = async (taskId: string): Promise<void> => {
        const ws = viewer.workspaceId;
        if (!ws || st.recovering) return;
        st.recovering = true;
        st.error = '';
        try {
            await actor(defs.Routing, routingKeyOf(ws)).resume(taskId as TaskId);
        } catch (e) {
            fail(e);
        } finally {
            st.recovering = false;
        }
    };

    /** "Retry turn" after a runtime error: the last message posted again — a new task, never a replay. */
    const retry = (): void => {
        const last = [...(history.value?.entries ?? [])].reverse().find((e) => e.entry.t === 'msg' && e.entry.author.kind === 'user');
        if (!last || last.entry.t !== 'msg') return;
        void send(last.entry.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''));
    };

    const respond = (requestId: string, decision: Decision): void => {
        const feed = feeds.list.find((f) => f.transcript.requests[requestId]);
        if (!feed) return;
        void session(feed.sessionId).respond(requestId, decision).catch(fail);
    };

    const addAgent = (agentId: string, access: 'all' | 'from'): void => {
        const k = key();
        if (!k) return;
        void actor(defs.Chat, k).addAgent(agentId as AgentId, access === 'all' ? 'all' : 'from-now').catch(fail);
    };

    const createChat = async (agentIds: readonly string[], coordinator: string | null): Promise<void> => {
        const ws = viewer.workspaceId;
        if (!ws) return;
        try {
            const chatId = await createChatWith(defs, ws, agentIds, coordinator);
            closeNewChat();
            await router.push(`/chats/${chatId}`);
        } catch (e) {
            fail(e);
        }
    };

    return (): JSXElement => {
        const s = summary.value;
        const notFound = summary.state === 'errored';
        if (notFound || (!viewer.pending && !viewer.workspaceId)) {
            return (
                <Page title="Chat not found">
                    <EmptyState
                        variant="generic"
                        title={viewer.workspaceId ? 'No chat with that id' : 'Sign in to see your chats'}
                        caption={viewer.workspaceId ? (summary.error?.message ?? `Nothing is called ${props.id}.`) : 'Chats belong to your workspace.'}
                        slots={{ actions: () => <Link to="/chats">Back to chats</Link> }}
                    />
                </Page>
            );
        }
        const members = s ? membersOf(s) : [];
        const chat: MockChatSummary = { id: props.id, title: s ? chatTitle(members, directory.lookup, s.title) : '…', members, lastLine: '', unread: 0, waiting: false, updatedAt: 0 };
        const addressing = resolveAddressing(members, mentionsIn(st.draft, members, directory.lookup), directory.lookup);
        const mentions: Mention[] = members.map((m) => {
            const a = directory.lookup(m.agentId);
            return { id: a.name, label: a.name, description: a.role };
        });
        const memberIds = new Set(members.map((m) => m.agentId));
        const candidates = directory.all().filter((a) => !memberIds.has(a.id));
        const tasks: readonly MockTaskRow[] = [];
        const failure = chatFailure(history.value?.entries ?? [], feeds.list);
        const empty = transcript.messages.length === 0;
        const loading = summary.loading && !s;
        return (
            <Page title={chat.title} page="chat" hideTitle flush>
                <LiveChatList currentId={props.id} directory={directory} onNewChat={openNewChat} />
                <section data-chat-main aria-label="Conversation" aria-busy={loading ? 'true' : undefined}>
                    {empty
                        ? <div data-chat-empty><EmptyState variant="chat" /></div>
                        : (
                            <Thread
                                transcript={transcript}
                                describe={(m) => authors.value[m.id]}
                                onRespond={respond}
                            />
                        )}
                    {failure ? (
                        <div data-chat-failure>
                            <FailureNotice
                                state={failure.state}
                                busy={st.recovering}
                                {...(failure.state.kind === 'interrupted' && failure.state.taskId ? { onResume: () => { void resume(failure.state.taskId!); } } : {})}
                                {...(failure.state.kind === 'runtime' ? { onRetry: retry } : {})}
                            />
                        </div>
                    ) : null}
                    {st.error ? <p data-chat-error role="alert">{st.error}</p> : null}
                    <div data-chat-composer onInput={(e: Event) => { st.draft = (e.target as HTMLTextAreaElement).value ?? ''; }}>
                        <Composer
                            recipients={addressing.recipients}
                            hint={addressing.recipients.length ? addressing.hint : NOBODY_HINT}
                            mentions={mentions}
                            busy={st.sending}
                            disabled={!s}
                            placeholder="Message the chat. @ to address an agent, otherwise the coordinator answers."
                            onSend={(text: string) => { void send(text); }}
                        />
                    </div>
                </section>
                <ContextPanel chat={chat} tasks={tasks} lookup={directory.lookup} candidates={candidates} onAddAgent={(e) => addAgent(e.agentId, e.access)} />
                <Drawer.Root model={() => contextDrawer.open} placement="end" label="Members and tasks" onOpenChange={(open: boolean) => { if (!open) closeContextDrawer(); }}>
                    <Drawer.Panel>
                        <div data-context-drawer>
                            <ContextPanel chat={chat} tasks={tasks} lookup={directory.lookup} candidates={candidates} onAddAgent={(e) => addAgent(e.agentId, e.access)} />
                        </div>
                    </Drawer.Panel>
                </Drawer.Root>
                <NewChatDialog model={() => newChatRequest.open} agents={directory.all()} onCancel={closeNewChat} onCreate={(e) => { void createChat(e.agentIds, e.coordinator); }} />
            </Page>
        );
    };
});
