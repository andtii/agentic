/**
 * Where a session's `SessionFiles` come from (#564): the mock workspace's
 * folder models (`mock/files.ts`) in mock mode; on the platform, the session's
 * machine through `machineWorkspaceSource` — the folder is the session's
 * `spec.cwd`, the base the project git feature's `base` setting, the views
 * offered decided by `workspaceCapabilities` from the machine's features.
 */
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
import { workspaceCapabilities, type ChangeScope, type EnvironmentId, type ProjectRecord } from '@agentic/core';
import { machineWorkspaceSource, type MachineFilesClient, type MachineView, type SessionInfo } from '@agentic/platform';
import type { ActorDefs, ViewerState } from '../../actors/defs';
import { chatKeyOf, machineKeyOf } from '../../actors/keys';
import { memoryWorkspaceSource, mockSessionFolder } from '../../mock/files';
import { chatSummary, formatTime, type MockSessionView } from '../../mock/workspace';
import { useProjects } from '../projects/live';
import type { ChangesSnapshot, LineQuestion, SessionFiles } from './files';

/** What the pages ask a machine: the files requests and, for the offline view, its last `changes` snapshot. */
export type MachineFilesPort = MachineFilesClient & { changesSnapshot?(environmentId: EnvironmentId, root: string, scope: ChangeScope): Promise<ChangesSnapshot | null> };

/** The questions asked in the mock workspace, newest last — it has no chat to post them to. */
export const mockQuestions: LineQuestion[] = [];

/**
 * A mock session's folder: the fixture behind its `cwd`, or none for a platform session. `hooks` are the chat
 * hooks (#565, `mockChatHooks`); the Transcript page's bar needs none. A question is also kept in `mockQuestions`.
 */
export function mockSessionFiles(v: MockSessionView, hooks: Pick<SessionFiles, 'ask' | 'mention' | 'fileActions'> = {}): SessionFiles {
    const folder = mockSessionFolder(v.cwd);
    const chat = v.chatId ? chatSummary(v.chatId) : undefined;
    return {
        sessionId: v.id,
        root: v.cwd,
        files: folder !== undefined,
        ...(folder ? { vcs: folder.vcs !== undefined } : {}),
        source: folder ? memoryWorkspaceSource(folder) : null,
        machineName: v.machine.name,
        online: v.machine.online,
        ...(chat ? { chat: { id: chat.id, title: chat.title } } : {}),
        time: formatTime,
        ...hooks,
        ask: async (q) => {
            mockQuestions.push(q);
            await hooks.ask?.(q);
        }
    };
}

/** The project git feature's `base` setting, when the project names one. */
export function gitBaseOf(project: Pick<ProjectRecord, 'features'> | undefined): string | undefined {
    for (const id of ['agentic.feature.git', 'git']) {
        const base = project?.features[id]?.['base'];
        if (typeof base === 'string' && base.trim()) return base.trim();
    }
    return undefined;
}

/**
 * The live session's files, from its record and its machine's: a daemon session with a `cwd` on a machine whose
 * daemon has the `files` feature gets Files (and Changes, until a `changes` answer says `not-a-repo`).
 */
export function liveSessionFiles(
    id: string,
    info: SessionInfo | null | undefined,
    machine: MachineView | null | undefined,
    client: ((machineId: string) => MachineFilesPort) | null,
    extra: { base?: string; chat?: { id: string; title: string }; time?: (ms: number) => string; hooks?: Pick<SessionFiles, 'ask' | 'mention' | 'fileActions'> } = {}
): SessionFiles | null {
    const spec = info?.spec;
    if (!info || !spec) return null;
    const cwd = spec.cwd ?? '';
    const machineId = spec.machineId;
    const env = spec.environmentId as EnvironmentId | undefined;
    const caps = workspaceCapabilities({ folder: !!machineId && !!env && !!cwd, ...(machine?.features ? { features: machine.features } : {}) });
    const online = machine?.online ?? false;
    const c = machineId && client ? client(machineId) : null;
    return {
        sessionId: id,
        root: cwd,
        files: caps.files,
        source: caps.files && c && env ? machineWorkspaceSource(c, env, cwd, extra.base !== undefined ? { base: extra.base } : {}) : null,
        machineName: machine?.name ?? machineId ?? 'the machine',
        online,
        ...(c?.changesSnapshot && env ? { snapshot: (scope: ChangeScope) => c.changesSnapshot!(env, cwd, scope) } : {}),
        ...(extra.chat ? { chat: extra.chat } : {}),
        ...(extra.time ? { time: extra.time } : {}),
        ...extra.hooks
    };
}

/**
 * The reads `liveSessionFiles` needs beside the session record and its machine (which the page already holds): the
 * chat (its title, its project) and the workspace's projects (the git base).
 */
export function useLiveFilesExtras(defs: Pick<ActorDefs, 'Chat' | 'Workspace'>, viewer: Pick<ViewerState, 'workspaceId'>, info: () => SessionInfo | null | undefined) {
    const chat = useActorState(defs.Chat, () => {
        const ws = viewer.workspaceId;
        const chatId = info()?.spec?.chatId;
        return ws && chatId && ([chatKeyOf(ws, chatId), 'get'] as const);
    }, { live: true });
    const projects = useProjects(defs, viewer);
    return (): { base?: string; chat?: { id: string; title: string } } => {
        const chatId = info()?.spec?.chatId;
        const summary = chat.value;
        const base = gitBaseOf(projects.byId(summary?.projectId));
        return {
            ...(base ? { base } : {}),
            ...(chatId ? { chat: { id: chatId, title: summary?.title ?? 'this chat' } } : {})
        };
    };
}

/** The Machine actor client `liveSessionFiles` asks through, for the viewer's workspace. */
export function machineClientFor(defs: Pick<ActorDefs, 'Machine'>, workspaceId: string) {
    return (machineId: string) => actor(defs.Machine, machineKeyOf(workspaceId, machineId)) as unknown as MachineFilesPort;
}
