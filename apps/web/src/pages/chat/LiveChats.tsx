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
import { useRoute, useRouter } from '@sigx/router';
import type { ChatSummary, IndexedEntry } from '@agentic/platform';
import { projectFolderFor, type AgentId, type EnvironmentId, type MachineId, type ProjectId, type ProjectRecord } from '@agentic/core';
import { EmptyState, ErrorNote } from '@agentic/ui';
import { Page } from '../../components/Page';
import { useActorDefs, useViewer, type ActorDefs, type ViewerState } from '../../actors/defs';
import { chatKeyOf, workspaceKeyOf } from '../../actors/keys';
import type { MockChatSummary } from '../../mock/workspace';
import { ChatList } from './ChatList';
import { useAgentDirectory, type AgentDirectory } from './directory';
import { closeNewChat, newChatRequest, openNewChat } from './head';
import { LIST_TAIL, chatRow } from './live';
import { baselineReadMarks, loadReadMarks, readMarks } from './read-marks';
import { NewChatDialog, type NewChatCreate } from './NewChatDialog';
import { newProjectLink, type NewChatPrefill } from './new-chat-prefill';
import { useProjects } from '../projects/live';
import { useLiveWorkdirEnvironments, type WorkdirEnvironments } from '../workdir/environments';
import type { AgentIdentity } from './live';

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
    const projects = useProjects(defs, viewer);
    return () => {
        const ws = viewer.workspaceId;
        return (
            <>
                <ChatList chats={chats.rows(props.currentId)} currentId={props.currentId} wide={props.wide} lookup={props.directory.lookup} projects={projects.list()} onNewChat={() => emit('newChat')} />
                {ws ? chats.ids().map((id) => <ChatWatch key={id} id={id} workspaceId={ws} onRead={chats.report} />) : null}
            </>
        );
    };
});

/** Create a chat with `agentIds` as members (all history), an optional coordinator, in a project (#333) and on a machine (#414) when named; resolves to the new id. */
export async function createChatWith(defs: ActorDefs, ws: string, agentIds: readonly string[], coordinator: string | null, projectId: string | null = null, machineId: string | null = null): Promise<string> {
    const { chatId } = await actor(defs.Workspace, workspaceKeyOf(ws)).createChat({ ...(projectId ? { projectId: projectId as ProjectId } : {}), ...(machineId ? { machineId: machineId as MachineId } : {}) });
    const chat = actor(defs.Chat, chatKeyOf(ws, chatId));
    for (const id of agentIds) await chat.addAgent(id as AgentId, 'all');
    if (coordinator) await chat.setCoordinator(coordinator as AgentId);
    return chatId;
}

/**
 * `createChatWith` from a prefilled opening (#336): a folder to save on the project goes through
 * `Workspace.upsertProject` first, so the chat inherits it; otherwise the folder is set on every picked member
 * that runs in that environment (`Chat.setWorkdir`, as "Start task" does for one agent) — where it runs on the
 * chat's machine (#414: its account's environment there, else its pinned one) — unless the project's folder
 * there is already this one.
 */
export async function createChatFrom(defs: ActorDefs, ws: string, input: NewChatCreate, environmentOf: (agentId: string, machineId: string | null) => string | undefined, project?: Pick<ProjectRecord, 'folders'>): Promise<string> {
    const { workdir } = input;
    const environmentId = workdir?.environmentId as EnvironmentId;
    if (workdir?.saveToProject && input.projectId) await actor(defs.Workspace, workspaceKeyOf(ws)).upsertProject({ id: input.projectId as ProjectId, folders: { [environmentId]: workdir.path } });
    const chatId = await createChatWith(defs, ws, input.agentIds, input.coordinator, input.projectId, input.machineId);
    if (workdir && !workdir.saveToProject && !(project && projectFolderFor(project, environmentId) === workdir.path)) {
        const chat = actor(defs.Chat, chatKeyOf(ws, chatId));
        for (const id of input.agentIds) if (environmentOf(id, input.machineId) === workdir.environmentId) await chat.setWorkdir(id as AgentId, { environmentId, path: workdir.path });
    }
    return chatId;
}

/** Where a member runs for `createChatFrom` (#414): its account's environment on the chat's machine, else its pin. */
export function memberEnvironmentFor(lookup: (id: string) => Pick<AgentIdentity, 'environment' | 'environmentId' | 'account'>, workdirs: Pick<WorkdirEnvironments, 'accountEnvironment' | 'hosted'>): (agentId: string, machineId: string | null) => string | undefined {
    return (agentId, machineId) => {
        const a = lookup(agentId);
        if (machineId && a.account) return workdirs.accountEnvironment(machineId, a.environment.runtime, a.account);
        if (machineId && a.environmentId && !workdirs.hosted(machineId, a.environmentId)) return undefined;
        return a.environmentId;
    };
}

/** `/chats` on the platform: the list at full width plus the new-chat dialog. */
export const LiveChats = component(() => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const router = useRouter();
    const route = useRoute();
    const directory = useAgentDirectory(defs, viewer);
    // Where each agent runs and its account's limits, on the New chat cards (#315).
    const workdirs = useLiveWorkdirEnvironments(defs, viewer);
    // The project picker (#333): the workspace's projects and the one used last.
    const projects = useProjects(defs, viewer);
    const st = signal({ busy: false, error: '' });
    const createChat = async (input: NewChatCreate): Promise<void> => {
        const ws = viewer.workspaceId;
        if (!ws) return;
        st.busy = true;
        try {
            const chatId = await createChatFrom(defs, ws, input, memberEnvironmentFor(directory.lookup, workdirs), projects.byId(input.projectId));
            // From the deep link (#336) the URL is replaced, so back never reopens it; the entry closes the dialog as it leaves.
            if (route.name === 'chat-new') await router.replace(`/chats/${chatId}`);
            else {
                closeNewChat();
                await router.push(`/chats/${chatId}`);
            }
        } catch (e) {
            st.error = e instanceof Error ? e.message : String(e);
        } finally {
            st.busy = false;
        }
    };
    /** "Create project from this folder" (#336): the project form, prefilled; the entry route closes the dialog as it leaves. */
    const createProject = (prefill: NewChatPrefill): void => { void router.replace(newProjectLink(prefill)); };
    return () => (
        <Page title="Chats" page="chats" hideTitle>
            {!viewer.pending && !viewer.workspaceId
                ? <EmptyState variant="generic" title="Sign in to see your chats" caption="Chats belong to your workspace." />
                : <LiveChatList wide directory={directory} onNewChat={openNewChat} />}
            {st.error ? <ErrorNote data-chat-error="">{st.error}</ErrorNote> : null}
            <NewChatDialog
                model={() => newChatRequest.open}
                agents={directory.all()}
                environments={workdirs.list()}
                projects={projects.list()}
                lastProjectId={projects.lastProjectId()}
                machines={workdirs.machines()}
                lastMachineId={workdirs.lastMachineId()}
                {...(newChatRequest.prefill ? { prefill: newChatRequest.prefill } : {})}
                busy={st.busy}
                onCancel={closeNewChat}
                onCreate={(e) => { void createChat(e); }}
                onCreateProject={createProject}
            />
        </Page>
    );
});
