/**
 * The chat list on the platform (#34): the Workspace's chat index read
 * live, each chat's summary and newest entry fetched in one `useData`
 * batch (per-row live reads are a follow-up), rendered through the same
 * `ChatList` the mock page uses.
 */
import { component, signal, useData, type Define } from 'sigx';
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
import { useRouter } from '@sigx/router';
import type { ChatSummary, IndexedEntry } from '@agentic/platform';
import type { AgentId } from '@agentic/core';
import { EmptyState } from '@agentic/ui';
import { Page } from '../../components/Page';
import { useActorDefs, useViewer, type ActorDefs, type ViewerState } from '../../actors/defs';
import { chatKeyOf, workspaceKeyOf } from '../../actors/keys';
import type { MockChatSummary } from '../../mock/workspace';
import { ChatList } from './ChatList';
import { useAgentDirectory, type AgentDirectory } from './directory';
import { closeNewChat, newChatRequest, openNewChat } from './head';
import { chatRow } from './live';
import { NewChatDialog } from './NewChatDialog';

interface ChatRead {
    readonly id: string;
    readonly summary: ChatSummary;
    readonly newest: readonly IndexedEntry[];
}

/** The workspace's chats, newest activity first, as list rows. */
export function useChatRows(defs: ActorDefs, viewer: ViewerState, directory: AgentDirectory): { rows(): MockChatSummary[]; readonly loading: boolean } {
    const index = useActorState(defs.Workspace, () => viewer.workspaceId && ([workspaceKeyOf(viewer.workspaceId), 'get'] as const), { live: true });
    const reads = useData(
        () => {
            const ws = viewer.workspaceId;
            const ids = index.value?.chats;
            return ws && ids ? (['chat-rows', ws, ...ids] as const) : false;
        },
        async (key): Promise<ChatRead[]> => {
            const [, ws, ...ids] = key as readonly [string, string, ...string[]];
            const out = await Promise.all(
                ids.map(async (id): Promise<ChatRead | null> => {
                    try {
                        const chat = actor(defs.Chat, chatKeyOf(ws, id));
                        const [summary, page] = await Promise.all([chat.get(), chat.history(null, 1)]);
                        return { id, summary, newest: page.entries };
                    } catch {
                        return null;
                    }
                })
            );
            return out.filter((r): r is ChatRead => r !== null);
        }
    );
    return {
        rows: () => (reads.value ?? []).map((r) => chatRow(r.id, r.summary, r.newest, directory.lookup)).sort((a, b) => b.updatedAt - a.updatedAt),
        get loading() {
            return index.loading || reads.loading;
        }
    };
}

export type LiveChatListProps =
    & Define.Prop<'currentId', string>
    & Define.Prop<'wide', boolean>
    & Define.Prop<'directory', AgentDirectory, true>
    & Define.Event<'newChat'>;

/** The list column, live. */
export const LiveChatList = component<LiveChatListProps>(({ props, emit }) => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const chats = useChatRows(defs, viewer, props.directory);
    return () => <ChatList chats={chats.rows()} currentId={props.currentId} wide={props.wide} lookup={props.directory.lookup} onNewChat={() => emit('newChat')} />;
});

/** Create a chat with `agentIds` as members (all history) and an optional coordinator; resolves to the new id. */
export async function createChatWith(defs: ActorDefs, ws: string, agentIds: readonly string[], coordinator: string | null): Promise<string> {
    const { chatId } = await actor(defs.Workspace, workspaceKeyOf(ws)).createChat({});
    const chat = actor(defs.Chat, chatKeyOf(ws, chatId));
    for (const id of agentIds) await chat.addAgent(id as AgentId, 'all');
    if (coordinator) await chat.setCoordinator(coordinator as AgentId);
    return chatId;
}

/** `/chats` on the platform: the list at full width plus the new-chat dialog. */
export const LiveChats = component(() => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const router = useRouter();
    const directory = useAgentDirectory(defs, viewer);
    const st = signal({ busy: false, error: '' });
    const createChat = async (agentIds: readonly string[], coordinator: string | null): Promise<void> => {
        const ws = viewer.workspaceId;
        if (!ws) return;
        st.busy = true;
        try {
            const chatId = await createChatWith(defs, ws, agentIds, coordinator);
            closeNewChat();
            await router.push(`/chats/${chatId}`);
        } catch (e) {
            st.error = e instanceof Error ? e.message : String(e);
        } finally {
            st.busy = false;
        }
    };
    return () => (
        <Page title="Chats" page="chats" hideTitle>
            {!viewer.pending && !viewer.workspaceId
                ? <EmptyState variant="generic" title="Sign in to see your chats" caption="Chats belong to your workspace." />
                : <LiveChatList wide directory={directory} onNewChat={openNewChat} />}
            {st.error ? <p data-chat-error role="alert">{st.error}</p> : null}
            <NewChatDialog model={() => newChatRequest.open} agents={directory.all()} busy={st.busy} onCancel={closeNewChat} onCreate={(e) => { void createChat(e.agentIds, e.coordinator); }} />
        </Page>
    );
});
