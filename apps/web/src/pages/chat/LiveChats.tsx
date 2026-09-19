/**
 * The chat list on the platform (#34): the Workspace's chat index read
 * live, each chat's summary and newest entries fetched in one `useData`
 * batch for the first paint, then kept current by one renderless watcher
 * per chat (#152) — a reply in another chat moves its row, raises its
 * unread count and shows its amber pill without a reload. Rendered through
 * the same `ChatList` the mock page uses.
 */
import { component, effect, onMounted, onUnmounted, signal, useData, type Define, type JSXElement } from 'sigx';
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
import { LIST_TAIL, chatRow } from './live';
import { baselineReadMarks, loadReadMarks, readMarks } from './read-marks';
import { NewChatDialog } from './NewChatDialog';
import { useLiveWorkdirEnvironments } from '../workdir/environments';

interface ChatRead {
    readonly id: string;
    readonly summary: ChatSummary;
    readonly newest: readonly IndexedEntry[];
}

export interface ChatRows {
    /** `currentId`: the chat that is open — everything in it is on screen, so it never counts as unread. */
    rows(currentId?: string): MockChatSummary[];
    /** The chats read so far, for the watchers. */
    ids(): string[];
    /** A watcher's newer read of one chat. */
    report(read: ChatRead): void;
    readonly loading: boolean;
}

/** The workspace's chats, newest activity first, as list rows. */
export function useChatRows(defs: ActorDefs, viewer: ViewerState, directory: AgentDirectory): ChatRows {
    const live = signal<{ map: Record<string, ChatRead> }>({ map: {} });
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
                        const [summary, page] = await Promise.all([chat.get(), chat.history(null, LIST_TAIL)]);
                        return { id, summary, newest: page.entries };
                    } catch {
                        return null;
                    }
                })
            );
            return out.filter((r): r is ChatRead => r !== null);
        }
    );
    const marksLoaded = signal({ value: false });
    const current = (): ChatRead[] => (reads.value ?? []).map((r) => live.map[r.id] ?? r);
    // First sight of a chat on this device starts its marker at the chat's present end (client only: the marks are loaded on mount).
    const stopBaseline = effect(() => {
        const ws = viewer.workspaceId;
        const list = reads.value;
        if (!ws || !list || !marksLoaded.value) return;
        baselineReadMarks(ws, list.map((r) => ({ id: r.id, seq: r.summary.seq })));
    });
    onMounted(() => {
        if (viewer.workspaceId) loadReadMarks(viewer.workspaceId);
        marksLoaded.value = true;
    });
    onUnmounted(stopBaseline);
    return {
        rows: (currentId) => {
            const marks = readMarks(viewer.workspaceId);
            // `current()` is in the Workspace index's order (creation), so a tie in the same millisecond goes to the later chat (#175).
            return current()
                .map((r, order) => ({ order, row: chatRow(r.id, r.summary, r.newest, directory.lookup, r.id === currentId ? Number.POSITIVE_INFINITY : marks[r.id]) }))
                .sort((a, b) => b.row.updatedAt - a.row.updatedAt || b.order - a.order)
                .map((r) => r.row);
        },
        ids: () => (marksLoaded.value ? (reads.value ?? []).map((r) => r.id) : []),
        report(read) {
            const prev = live.map[read.id];
            // Every change to a chat is an entry, so its seq says whether this read is news; the tail may trail the summary by a frame.
            if (prev && prev.summary.seq === read.summary.seq && prev.newest.length === read.newest.length && prev.newest[prev.newest.length - 1]?.seq === read.newest[read.newest.length - 1]?.seq) return;
            live.map = { ...live.map, [read.id]: read };
        },
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

/** Renderless: keeps one chat's row current through live reads of `Chat.get` and its newest entries (the `MachineWatch` pattern). */
const ChatWatch = component<{ id: string; workspaceId: string; onRead: (read: ChatRead) => void }>(({ props }) => {
    const defs = useActorDefs();
    const summary = useActorState(defs.Chat, () => [chatKeyOf(props.workspaceId, props.id), 'get'] as const, { live: true });
    const tail = useActorState(defs.Chat, () => [chatKeyOf(props.workspaceId, props.id), 'history', null, LIST_TAIL] as const, { live: true });
    const stop = effect(() => {
        if (summary.value && tail.value) props.onRead({ id: props.id, summary: summary.value, newest: tail.value.entries });
    });
    onUnmounted(stop);
    return (): JSXElement => null;
});

/** The list column, live. */
export const LiveChatList = component<LiveChatListProps>(({ props, emit }) => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const chats = useChatRows(defs, viewer, props.directory);
    return () => {
        const ws = viewer.workspaceId;
        return (
            <>
                <ChatList chats={chats.rows(props.currentId)} currentId={props.currentId} wide={props.wide} lookup={props.directory.lookup} onNewChat={() => emit('newChat')} />
                {ws ? chats.ids().map((id) => <ChatWatch key={id} id={id} workspaceId={ws} onRead={chats.report} />) : null}
            </>
        );
    };
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
    // Where each agent runs and its account's limits, on the New chat cards (#315).
    const workdirs = useLiveWorkdirEnvironments(defs, viewer);
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
            <NewChatDialog model={() => newChatRequest.open} agents={directory.all()} environments={workdirs.list()} busy={st.busy} onCancel={closeNewChat} onCreate={(e) => { void createChat(e.agentIds, e.coordinator); }} />
        </Page>
    );
});
