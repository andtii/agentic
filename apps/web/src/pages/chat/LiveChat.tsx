/**
 * `/chats/:id` on the platform (#34): the Chat actor read live
 * (`get` for members, coordinator and active sessions; `history` for the
 * entries), one session feed per active session tailed through
 * `connectSession`, the composer posting to `Chat.post` and starting the
 * activated agents' tasks through the router. Same columns, same
 * components as the mock page — only the data source differs.
 *
 * #152: the context panel's tasks are this chat's chains out of the
 * workspace's task index (`chatTasks`), "Stop task chain" cancels them
 * (`Task.cancel`, which takes the subtree), a member with a request open
 * reads WAITING, the user reads as "You", times follow the workspace's
 * zone, the topbar's search and settings buttons open a panel over
 * `Chat.search` and a dialog over `rename` / `setCoordinator` /
 * `removeAgent`, and having the chat open moves this device's read marker.
 *
 * #399: "New session" on a member (the context panel, in the drawer on a
 * phone) is `Routing.endSession` after a confirmation; the chat's binding
 * drops with it, so its feed closes and the next message opens a fresh one.
 *
 * #207: files the composer takes (pick, paste, drop) are shrunk when they are
 * photos (`prepareImage`), uploaded to `POST /files/chats/:chatId` and shown
 * as chips; a send posts the text and the ready chips' `agentic-file:` parts
 * (`runActivation`), then clears them.
 *
 * #398: the chat opens newest-first (CHT-08). The thread holds the newest
 * page of entries (a live read) merged with every older page the reader has
 * scrolled up to (`Chat.history(cursor)` from the last page's `next`, until
 * it is `null` — the caller's `historyFrom`); nothing older is read until
 * asked for. Each member's feed follows its session from the last turn's end
 * (`feeds.ts`), so it carries the turn running now and never replays the
 * session's past — every earlier turn's final message is already an entry.
 */
import { component, effect, onMounted, onUnmounted, signal, watch, type JSXElement } from 'sigx';
import { Link, useRoute, useRouter } from '@sigx/router';
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
import { Drawer } from '@sigx/zero';
import { createId, isChatFilePart, sessionFileUri, type AgentId, type ChatFilePart, type ChatId, type MachineId, type PromptPart, type SessionOptionsPatch, type TaskId, type WorkdirRef } from '@agentic/core';
import { activeIn, type IndexedEntry } from '@agentic/platform';
import type { Decision, ToolPartState } from '@sigx/ai-agent';
import { Composer, EmptyState, NOBODY_HINT, Thread, prepareImage, type ComposerInsert, type Mention, type MessageAuthor, type RespondOptions } from '@agentic/ui';
import { Page } from '../../components/Page';
import { baseTurnId, capacityWaitText, FailureNotice, interruptionOf, machineOfflineText, useInterruptionReads } from '../../components/status';
import { useActorDefs, useViewer } from '../../actors/defs';
import { chatKeyOf, inboxKeyOf, machineKeyOf, routingKeyOf, sessionKeyOf, taskIndexKeyOf, taskKeyOf } from '../../actors/keys';
import { resolveAddressing, type MockChatSummary } from '../../mock/workspace';
import { useWorkspaceZone, zoneFormat } from '../../time';
import { ChatSearchPanel, SEARCH_LIMIT } from './ChatSearchPanel';
import { ChatSettingsDialog, type ChatSettingsChange } from './ChatSettingsDialog';
import { ContextPanel } from './ContextPanel';
import { DetachedQuestionCard } from './DetachedQuestionCard';
import { closeContextDrawer, contextDrawer } from './context-drawer';
import { useAgentDirectory } from './directory';
import { openFeed, type FeedHandle } from './feeds';
import { chatHead, chatSearchRequest, chatSettingsRequest, closeChatSearch, closeChatSettings, closeNewChat, newChatRequest, openNewChat } from './head';
import { answerRequest, chatFailure, type InterruptionOfTurn, chatTasks, chatTitle, chatTranscript, chatWaitsOf, composeTranscript, detachedQuestions, entryTranscript, keepEntries, lastOf, membersOf, mentionsIn, notStoppedLine, queuedAgents, runActivation, stopTargets, waitingAgents, workingAgents, type SessionActorClient } from './live';
import { LiveChatList, createChatWith } from './LiveChats';
import { queryOf } from '../session/files';
import { fileToken, fileTokensIn, mentionOfQuery, viewDiffLinks } from '../session/references';
import { NewChatDialog } from './NewChatDialog';
import { markSeen } from './read-marks';
import { useProjects } from '../projects/live';
import { useLiveWorkdirEnvironments } from '../workdir/environments';
import { previewable, readyParts, uploadChatFile, uploaded, type Upload } from './uploads';

/** Who the user reads as in their own thread. */
export const YOU = 'You';

/** Entries read per page — the Chat actor's page maximum: the newest page on open, one more per scroll to the top (#398). */
export const HISTORY_LIMIT = 200;

export const LiveChat = component<{ id: string }>(({ props }) => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const router = useRouter();
    const directory = useAgentDirectory(defs, viewer);
    const key = (): string | null => (viewer.workspaceId ? chatKeyOf(viewer.workspaceId, props.id) : null);

    const summary = useActorState(defs.Chat, () => { const k = key(); return k && ([k, 'get'] as const); }, { live: true });
    const history = useActorState(defs.Chat, () => { const k = key(); return k && ([k, 'history', null, HISTORY_LIMIT] as const); }, { live: true });

    // Every task of the workspace, live: the panel keeps this chat's chains (`chatTasks`).
    const index = useActorState(defs.TaskIndex, () => viewer.workspaceId && ([taskIndexKeyOf(viewer.workspaceId), 'list'] as const), { live: true });
    // Which session asked each open question (#285): a question that outlived its session is answered from its own card.
    const inbox = useActorState(defs.Inbox, () => viewer.workspaceId && ([inboxKeyOf(viewer.workspaceId), 'list'] as const), { live: true });
    const zone = useWorkspaceZone(defs, viewer);
    const workdirs = useLiveWorkdirEnvironments(defs, viewer);
    // The chat's project (#333): its folder per environment is what a member without an override runs in.
    const projects = useProjects(defs, viewer);
    const time = (at: number): string => zoneFormat(zone()).time(at);
    // Why a member's turn was cut and where its resume stands (#368): the Audit's rows and the router's routes, live.
    const cuts = useInterruptionReads(defs, viewer);
    const machineNameOf = (id: string): string | undefined => workdirs.machines().find((m) => m.id === id)?.name;
    // A message parked on its environment's capacity (#652): the machine its route runs on, read live only while one
    // waits — the environment's name, its limit and the turns running there, so the notice says why and what to change.
    const capacity = (): { machineId: string; environmentId: string } | undefined => {
        const c = chatWaitsOf(index.value ?? [], props.id).capacity;
        if (!c) return undefined;
        const machineId = cuts.routes().find((r) => r.taskId === c.taskId)?.machineId ?? summary.value?.machineId ?? workdirs.machineOf(c.wait.environmentId);
        return machineId ? { machineId, environmentId: c.wait.environmentId } : undefined;
    };
    const capacityMachine = useActorState(defs.Machine, () => { const ws = viewer.workspaceId; const c = capacity(); return ws && c && ([machineKeyOf(ws, c.machineId), 'get'] as const); }, { live: true });
    const interruptionOfTurn: InterruptionOfTurn = (turnId, agentId) => {
        const base = turnId ? baseTurnId(turnId) : undefined;
        const mine = cuts.routes().filter((r) => r.chatId === props.id && r.agentId === agentId);
        const route = base ? mine.find((r) => r.turnId !== undefined && baseTurnId(r.turnId) === base) : mine.find((r) => r.status === 'interrupted');
        const row = base ? cuts.audit().find((e) => e.kind === 'session.interrupted' && e.data.turnId === base) : undefined;
        const taskId = route?.taskId ?? (row?.kind === 'session.interrupted' ? row.data.taskId : undefined);
        return { interruption: interruptionOf({ audit: cuts.audit(), ...(base ? { turnId: base } : {}), ...(taskId ? { taskId } : {}), route: route ?? null, machineName: machineNameOf }), ...(taskId ? { taskId } : {}) };
    };

    const st = signal({ draft: '', error: '', sending: false, recovering: false, stopping: false, saving: false, resetting: false });
    const transcript = signal(chatTranscript('chat'));
    const authors = signal<{ value: Record<string, MessageAuthor> }>({ value: {} });
    const feeds = signal<{ list: FeedHandle[] }>({ list: [] });
    // The composer's chips (#207): one per file taken, until it is sent or removed.
    const uploads = signal<{ list: Upload[] }>({ list: [] });
    let uploadSeq = 0;

    // "Mention in chat" from a session's Files (#565): `?file=<agentic-session:// uri>` puts `@file:<path>` into the
    // composer once and remembers which session's folder the path is in, so the message carries the reference.
    const route = useRoute();
    const mention = signal<{ insert: ComposerInsert | null; sessions: Record<string, string> }>({ insert: null, sessions: {} });
    let mentionSeq = 0;
    onMounted(() => {
        const stopMention = watch(
            () => queryOf(route.query.file),
            (value) => {
                const m = mentionOfQuery(value);
                if (!m) return;
                mention.sessions = { ...mention.sessions, [m.path]: m.sessionId };
                mention.insert = { id: ++mentionSeq, text: `${fileToken(m.path)} ` };
                // Consumed: a reload or a later visit does not insert it again.
                void router.replace(`/chats/${encodeURIComponent(props.id)}`);
            },
            { immediate: true }
        );
        onUnmounted(() => stopMention.stop());
    });
    /** The `resource` parts for the `@file:` tokens of a message whose session is known. */
    const fileReferences = (text: string): PromptPart[] => fileTokensIn(text).flatMap((path) => {
        const sessionId = mention.sessions[path];
        return sessionId ? [{ type: 'resource' as const, uri: sessionFileUri(sessionId, path) }] : [];
    });
    /** "View diff" on a call that wrote a file (#565): which session made the call, and what its runtime says it wrote. */
    const toolLinks = (part: ToolPartState) => {
        const feed = feeds.list.find((f) => f.transcript.messages.some((m) => m.parts.some((p) => p.type === 'tool' && p.callId === part.callId)));
        return feed ? viewDiffLinks(directory.lookup(feed.agentId).environment.runtime, feed.sessionId, part) : undefined;
    };

    const session = (sessionId: string): SessionActorClient => actor(defs.Session, sessionKeyOf(viewer.workspaceId!, sessionId)) as unknown as SessionActorClient;
    const fail = (e: unknown): void => { st.error = e instanceof Error ? e.message : String(e); };

    // The entries the thread holds (#398): the live newest page merged into every page read before it, by seq
    // (`keepEntries`), so a stretch the live page has slid past stays on screen. `older.next` is the cursor of the
    // page before the oldest held — the live page's `next` when it first arrives, then each older page's — and
    // `null` once the caller's `historyFrom` is reached.
    let held: readonly IndexedEntry[] = [];
    const kept = signal<{ list: readonly IndexedEntry[] }>({ list: [] });
    const older = signal<{ next: number | null | undefined; loading: boolean }>({ next: undefined, loading: false });
    const keep = (page: readonly IndexedEntry[]): void => {
        const next = keepEntries(held, page);
        if (next !== held) {
            held = next;
            kept.list = next;
        }
    };
    const stopKeep = effect(() => {
        const page = history.value;
        if (!page) return;
        const first = held.length === 0;
        keep(page.entries);
        if (first) older.next = page.next;
    });
    onUnmounted(stopKeep);

    /** The thread reached its top (`Thread.onEarlier`): read the page before the oldest held, once at a time. */
    const loadOlder = async (): Promise<void> => {
        const k = key();
        const cursor = older.next;
        if (!k || older.loading || cursor === null || cursor === undefined) return;
        older.loading = true;
        try {
            const page = await actor(defs.Chat, k).history(cursor, HISTORY_LIMIT);
            keep(page.entries);
            older.next = page.next;
        } catch (e) {
            fail(e);
        } finally {
            older.loading = false;
        }
    };

    // The feeds follow `sessions` (#392): opened on the client only (a server render tails nothing), closed when a session leaves the chat or the page unmounts.
    onMounted(() => {
        const stop = effect(() => {
            const bound = summary.value?.sessions ?? {};
            const wanted = new Map(Object.entries(bound).map(([agentId, row]) => [row.sessionId as string, agentId]));
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
        // Open on this device: everything up to the chat's end has been on screen (client only — the marker is this browser's).
        const stopSeen = effect(() => {
            const ws = viewer.workspaceId;
            const seq = summary.value?.seq;
            if (ws && seq !== undefined) markSeen(ws, props.id, seq);
        });
        onUnmounted(stopSeen);
    });

    // The thread's one transcript: the chat's rows plus every feed's in-flight rows, recomposed as either side changes.
    const stopCompose = effect(() => {
        const entries = entryTranscript(kept.list, directory.lookup, YOU, time, interruptionOfTurn);
        authors.value = composeTranscript(transcript, entries, feeds.list, directory.lookup);
    });
    onUnmounted(stopCompose);

    // The topbar reads the title and members from here.
    const stopHead = effect(() => {
        const s = summary.value;
        const members = s ? membersOf(s, waitingAgents(kept.list), workingAgents(index.value ?? [], props.id), queuedAgents(index.value ?? [], props.id)) : [];
        const identities = Object.fromEntries(members.map((m) => [m.agentId, directory.lookup(m.agentId)]));
        chatHead.value = { id: props.id, title: s ? chatTitle(members, directory.lookup, s.title) : props.id, members, identities, ...(s?.project ? { project: s.project } : {}), ...(s?.machine ? { machine: { ...s.machine, online: workdirs.machines().find((m) => m.id === s.machine!.id)?.online ?? false } } : s?.machineId ? { machine: { id: s.machineId, name: s.machineId, online: false } } : {}) };
    });
    onUnmounted(stopHead);

    const patchUpload = (id: string, change: (chip: Upload) => Upload): void => {
        // A chip removed while its upload ran stays removed.
        if (uploads.list.some((c) => c.id === id)) uploads.list = uploads.list.map((c) => (c.id === id ? change(c) : c));
    };
    const dropUploads = (ids: ReadonlySet<string>): void => {
        for (const c of uploads.list) if (ids.has(c.id) && c.previewUrl) URL.revokeObjectURL(c.previewUrl);
        uploads.list = uploads.list.filter((c) => !ids.has(c.id));
    };
    onUnmounted(() => dropUploads(new Set(uploads.list.map((c) => c.id))));

    /** The composer's `files` (#207): a chip per file at once, then the photo shrunk and the bytes uploaded. */
    const attach = (files: readonly File[]): void => {
        const chatId = props.id;
        for (const file of files) {
            const id = `upload-${++uploadSeq}`;
            const previewUrl = previewable(file.type) && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : undefined;
            uploads.list = [...uploads.list, { id, name: file.name, size: file.size, status: 'uploading', ...(previewUrl ? { previewUrl } : {}) }];
            void (async () => {
                try {
                    const result = await uploadChatFile(chatId, await prepareImage(file, { maxEdge: 1568, quality: 0.85 }));
                    patchUpload(id, (c) => uploaded(c, result));
                } catch (e) {
                    patchUpload(id, (c) => ({ ...c, status: 'error', error: e instanceof Error ? e.message : String(e) }));
                }
            })();
        }
    };

    /** Post and activate. `reshare`: files already in the chat to post again (a retry) instead of the composer's chips. */
    const send = async (text: string, reshare?: readonly ChatFilePart[]): Promise<void> => {
        const ws = viewer.workspaceId;
        const s = summary.value;
        if (!ws || !s || st.sending) return;
        // The chips that go with this message: every ready one (the composer holds Send while one uploads).
        const sent = reshare ? [] : uploads.list.filter((c) => c.status === 'ready' && c.part);
        const attachments: readonly PromptPart[] = reshare ?? [...readyParts(sent), ...fileReferences(text)];
        if (!text && !attachments.length) return;
        const k = chatKeyOf(ws, props.id);
        const members = membersOf(s);
        st.sending = true;
        st.error = '';
        try {
            await runActivation(
                {
                    post: (parts, mentions) => actor(defs.Chat, k).post(parts, mentions),
                    createTask: (id, contract, owner) => actor(defs.TaskActor, taskKeyOf(ws, id)).create(contract, { owner }),
                    // One-way (#492): the router places the task on its own time — a daemon's git hooks, another session's
                    // slow turn — and the page reads the outcome from the live task index and the chat's entries. Awaited,
                    // a placement that outran the host's call deadline failed this send in a chat that never touched them.
                    run: (taskId) => actor(defs.Routing, routingKeyOf(ws)).with({ oneWay: true }).run(taskId),
                    newTaskId: () => createId('task') as TaskId
                },
                { chatId: props.id as ChatId, text, attachments, mentions: mentionsIn(text, members, directory.lookup), summary: s, entries: kept.list, lookup: directory.lookup, hosted: workdirs.hosted }
            );
            st.draft = '';
            dropUploads(new Set(sent.map((c) => c.id)));
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
        const last = [...(kept.list)].reverse().find((e) => e.entry.t === 'msg' && e.entry.author.kind === 'user');
        if (!last || last.entry.t !== 'msg') return;
        void send(last.entry.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''), last.entry.parts.filter(isChatFilePart));
    };

    const respond = (requestId: string, decision: Decision, options?: RespondOptions): void => {
        const feed = feeds.list.find((f) => f.transcript.requests[requestId]);
        if (!feed) return;
        const k = key();
        const client = session(feed.sessionId);
        void answerRequest(
            {
                respond: (id, d) => client.respond(id, d),
                setOptions: (agentId, patch) => (k ? actor(defs.Chat, k).setOptions(agentId as AgentId, patch) : Promise.resolve()),
                configure: (patch) => client.configure(patch)
            },
            feed.agentId,
            requestId,
            decision,
            options
        ).catch(fail);
    };

    /** A member's model or permission mode for this chat (#453): its next turn runs with it; a running turn keeps its own. */
    const setOptions = (agentId: string, patch: SessionOptionsPatch): void => {
        const k = key();
        if (!k) return;
        void actor(defs.Chat, k).setOptions(agentId as AgentId, patch).catch(fail);
    };

    /** A member's folder for this chat (#193): the next task the chat starts for it runs there; a running session keeps its own. */
    const setWorkdir = (agentId: string, ref: WorkdirRef | null): void => {
        const k = key();
        if (!k) return;
        void actor(defs.Chat, k).setWorkdir(agentId as AgentId, ref).catch(fail);
    };

    const addAgent = (agentId: string, access: 'all' | 'from'): void => {
        const k = key();
        if (!k) return;
        void actor(defs.Chat, k).addAgent(agentId as AgentId, access === 'all' ? 'all' : 'from-now').catch(fail);
    };

    /** "Stop task chain": cancel every chain of this chat that still runs; `Task.cancel` stops the subtree and names what it could not (COL-12). */
    const stopChain = async (): Promise<void> => {
        const ws = viewer.workspaceId;
        if (!ws || st.stopping) return;
        st.stopping = true;
        st.error = '';
        try {
            const tasks = chatTasks(index.value ?? [], props.id);
            const reports = await Promise.all(stopTargets(tasks).map((t) => actor(defs.TaskActor, taskKeyOf(ws, t.id)).cancel('user')));
            st.error = notStoppedLine(reports, index.value ?? []) ?? '';
        } catch (e) {
            fail(e);
        } finally {
            st.stopping = false;
        }
    };

    /** "New session" for a member (#399): the router ends its session — the running turn with it — and purges the record; the next message opens a fresh one. */
    const resetSession = async (agentId: string): Promise<void> => {
        const ws = viewer.workspaceId;
        if (!ws || st.resetting) return;
        st.resetting = true;
        st.error = '';
        try {
            await actor(defs.Routing, routingKeyOf(ws)).endSession(props.id as ChatId, agentId as AgentId, 'new session from the chat');
        } catch (e) {
            fail(e);
        } finally {
            st.resetting = false;
        }
    };

    /** "Chat settings": members leave first (a leaving coordinator takes the role with it), then the coordinator, then the title. */
    const saveSettings = async (change: ChatSettingsChange): Promise<void> => {
        const k = key();
        if (!k || st.saving) return;
        st.saving = true;
        st.error = '';
        try {
            const chat = actor(defs.Chat, k);
            for (const id of change.remove) await chat.removeAgent(id as AgentId);
            if (change.coordinator !== undefined) await chat.setCoordinator(change.coordinator as AgentId | null);
            if (change.title !== undefined) await chat.rename(change.title);
            // The machine (#414): applies from each member's next message, in a fresh session there (§7 placement moved).
            if (change.machineId !== undefined) await chat.setMachine(change.machineId as MachineId | null);
            closeChatSettings();
        } catch (e) {
            fail(e);
        } finally {
            st.saving = false;
        }
    };

    const search = (q: string) => actor(defs.Chat, key()!).search(q, SEARCH_LIMIT);

    // The topbar's requests are module-level (`head.ts`): leaving the page closes them.
    onUnmounted(() => {
        closeChatSearch();
        closeChatSettings();
    });

    const createChat = async (agentIds: readonly string[], coordinator: string | null, projectId: string | null, machineId: string | null): Promise<void> => {
        const ws = viewer.workspaceId;
        if (!ws) return;
        try {
            const chatId = await createChatWith(defs, ws, agentIds, coordinator, projectId, machineId);
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
        const entries = kept.list;
        const waiting = waitingAgents(entries);
        const members = s ? membersOf(s, waiting, workingAgents(index.value ?? [], props.id), queuedAgents(index.value ?? [], props.id)) : [];
        const last = lastOf(entries, directory.lookup);
        // The open chat as a summary: nothing in it is unread — it is on screen.
        const chat: MockChatSummary = { id: props.id, title: s ? chatTitle(members, directory.lookup, s.title) : '…', members, lastLine: last.line, unread: 0, waiting: waiting.size > 0, updatedAt: last.at, ...(s?.projectId ? { projectId: s.projectId } : {}), ...(s?.machineId ? { machineId: s.machineId } : {}) };
        const machineName = s?.machine?.name ?? s?.machineId;
        const project = projects.byId(s?.projectId);
        const addressing = resolveAddressing(members, mentionsIn(st.draft, members, directory.lookup), directory.lookup);
        const mentions: Mention[] = members.map((m) => {
            const a = directory.lookup(m.agentId);
            return { id: a.name, label: a.name, description: a.role };
        });
        const memberIds = new Set(members.map((m) => m.agentId));
        const candidates = directory.all().filter((a) => !memberIds.has(a.id));
        const tasks = chatTasks(index.value ?? [], props.id);
        const failure = chatFailure(entries, feeds.list, interruptionOfTurn, machineNameOf);
        // A task of this chat waiting on its machine (#366): a wait, never a failure — the machine, since when, and the deadline.
        // One waiting for a free slot (#652): where, how full it is, and the link that changes the limit.
        const waits = chatWaitsOf(index.value ?? [], props.id);
        const offline = waits.offline;
        const slot = waits.capacity;
        const slotAt = slot ? capacity() : undefined;
        const slotView = slot && slotAt && capacityMachine.value?.machineId === slotAt.machineId ? capacityMachine.value : undefined;
        const slotEnv = slotView?.environments.find((e) => e.id === slot?.wait.environmentId);
        const empty = transcript.messages.length === 0;
        const loading = summary.loading && !s;
        return (
            <Page title={chat.title} page="chat" hideTitle flush>
                <LiveChatList currentId={props.id} directory={directory} onNewChat={openNewChat} />
                <section data-chat-main aria-label="Conversation" aria-busy={loading ? 'true' : undefined}>
                    {chatSearchRequest.open && s ? <ChatSearchPanel search={search} lookup={directory.lookup} time={time} onClose={closeChatSearch} /> : null}
                    {empty
                        ? <div data-chat-empty><EmptyState variant="chat" /></div>
                        : (
                            <Thread
                                transcript={transcript}
                                describe={(m) => authors.value[m.id]}
                                toolLinks={toolLinks}
                                hasEarlier={older.next !== null && older.next !== undefined}
                                onEarlier={() => { void loadOlder(); }}
                                onRespond={respond}
                                describeRequest={(r) => {
                                    const feed = feeds.list.find((f) => f.transcript.requests[r.requestId]);
                                    if (!feed) return undefined;
                                    const who = directory.lookup(feed.agentId);
                                    return { requestedBy: { name: who.name, hue: who.hue } };
                                }}
                            />
                        )}
                    {detachedQuestions(entries, inbox.value ?? [], feeds.list, s?.sessions).map((q) => (
                        <div key={`${q.sessionId}:${q.requestId}`} data-chat-question>
                            <DetachedQuestionCard question={q} lookup={directory.lookup} onError={fail} />
                        </div>
                    ))}
                    {failure ? (
                        <div data-chat-failure>
                            <FailureNotice
                                state={failure.state}
                                busy={st.recovering}
                                {...(failure.state.kind === 'interrupted' && failure.state.taskId ? { onResume: () => { void resume(failure.state.taskId!); } } : {})}
                                {...(failure.state.kind === 'runtime' || failure.state.retry ? { onRetry: retry } : {})}
                            />
                        </div>
                    ) : null}
                    {offline ? (
                        <p data-chat-wait role="status">
                            {machineOfflineText(offline, machineNameOf(offline.machineId), time)} <Link to={`/machines/${offline.machineId}`}>Open machine</Link>
                        </p>
                    ) : null}
                    {slot ? (
                        <p data-chat-wait data-chat-wait-capacity role="status">
                            {capacityWaitText(slot.wait, { ...(slotEnv ? { environment: slotEnv.name } : {}), ...(slotView ? { machine: slotView.name } : {}) }, slotView && slotEnv ? { active: activeIn(slotView, slotEnv.id), max: slotEnv.concurrency.max } : undefined)}
                            {slotAt ? <> <Link to={`/machines/${slotAt.machineId}?env=${encodeURIComponent(slotAt.environmentId)}`}>Change limit</Link></> : null}
                        </p>
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
                            attachments={uploads.list}
                            onFiles={(files: File[]) => attach(files)}
                            onRemoveAttachment={(id: string) => dropUploads(new Set([id]))}
                            {...(mention.insert ? { insert: mention.insert } : {})}
                            onDraft={(draft: string) => { st.draft = draft; }}
                            onSend={(text: string) => { void send(text); }}
                        />
                    </div>
                </section>
                <ContextPanel chat={chat} tasks={tasks} lookup={directory.lookup} candidates={candidates} time={time} onAddAgent={(e) => addAgent(e.agentId, e.access)} onStopChain={() => { void stopChain(); }} environments={workdirs.list()} machineOf={workdirs.machineOf} project={project} {...(machineName ? { machineName } : {})} hosted={workdirs.hosted} accountEnvironment={workdirs.accountEnvironment} onSetWorkdir={(e) => setWorkdir(e.agentId, e.ref)} onResetSession={(e) => { void resetSession(e.agentId); }} onSetOptions={(e) => setOptions(e.agentId, e.patch)} />
                <Drawer.Root model={() => contextDrawer.open} placement="end" label="Members and tasks" onOpenChange={(open: boolean) => { if (!open) closeContextDrawer(); }}>
                    <Drawer.Panel>
                        <div data-context-drawer>
                            <ContextPanel chat={chat} tasks={tasks} lookup={directory.lookup} candidates={candidates} time={time} onAddAgent={(e) => addAgent(e.agentId, e.access)} onStopChain={() => { void stopChain(); }} environments={workdirs.list()} machineOf={workdirs.machineOf} project={project} {...(machineName ? { machineName } : {})} hosted={workdirs.hosted} accountEnvironment={workdirs.accountEnvironment} onSetWorkdir={(e) => setWorkdir(e.agentId, e.ref)} onResetSession={(e) => { void resetSession(e.agentId); }} onSetOptions={(e) => setOptions(e.agentId, e.patch)} />
                        </div>
                    </Drawer.Panel>
                </Drawer.Root>
                {chatSettingsRequest.open && s ? <ChatSettingsDialog model={() => chatSettingsRequest.open} title={s.title ?? ''} members={members} lookup={directory.lookup} machineId={s.machineId ?? ''} machines={workdirs.machines()} busy={st.saving} onCancel={closeChatSettings} onSave={(change) => { void saveSettings(change); }} /> : null}
                <NewChatDialog model={() => newChatRequest.open} agents={directory.all()} environments={workdirs.list()} projects={projects.list()} lastProjectId={projects.lastProjectId()} machines={workdirs.machines()} lastMachineId={workdirs.lastMachineId()} onCancel={closeNewChat} onCreate={(e) => { void createChat(e.agentIds, e.coordinator, e.projectId, e.machineId); }} />
            </Page>
        );
    };
});
