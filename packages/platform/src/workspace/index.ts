/**
 * Workspace — the per-user root actor (architecture §4, §9; USR-01/02,
 * OPS-01/10). Keyed `ws:{userId}`; owns the index of everything in the
 * workspace, the settings, and the pairing codes machines register with.
 *
 * Its `authorize` chain is the one every other actor copies:
 * `[sameWorkspace, <who may call this actor>]`.
 *
 * Persistence is explicit and every mutation ends in `ctx.save()` inside the
 * turn — on Cloudflare `onDeactivate` never runs (architecture §3).
 *
 * `exportAll` / `deleteAll` (OPS-10) are detached tasks over the app-level
 * `ArtifactSink` / `WorkspaceStore` ports (`defineWorkspace({ sink, store })`);
 * the cascade itself lives in `cascade.ts`. The default `Workspace` has no
 * ports: its tasks record the failure in `ops` and change nothing.
 */

import type { AgentId, ChatFileStore, ChatId, ConnectorRef, EnvironmentDescriptor, EnvironmentId, HostOs, MachineId, NotificationPrefs, ProjectFeatures, ProjectId, ProjectMembers, ProjectPatch, ProjectRecord, RetentionSettings, ScheduleId, UpdateSettings, WorkdirRef, WorkspaceDefaults, WorkspaceId, WorkspaceSettings } from '@agentic/core';
import { actorKey, createId, DEFAULT_UPDATE_SETTINGS, DEFAULT_WORKSPACE_SETTINGS, pathWithin, PROJECTS_MAX } from '@agentic/core';
import { defineActor, type ActorContext, type ActorPolicy, type AnyActorDefinition } from '@sigx/actors';
import { ServerFnError } from '@sigx/server';
import { recordAudit } from '../audit/port.js';
import { sameWorkspace, workspaceOwner, WORKSPACE_KEY_PREFIX } from '../auth/index.js';
import { Chat } from '../chat/index.js';
import { defineMachineActor, machineKey, type MachineView } from '../machine/index.js';
import { checkChannel, checkUpdatePolicy } from '../machine/update.js';
import { PAIRING_DIRECTORY_KEY, PairingDirectory } from '../pairing/directory.js';
import { Registry } from '../registry/actor.js';
import { registryKey } from '../registry/key.js';
import { deleteWorkspace, exportWorkspace } from './cascade.js';
import type { ArtifactSink, WorkspaceStore } from './ports.js';

export const WORKSPACE_STATE_VERSION = 1;

/** Pairing codes: 6 chars, 10 minutes, single use (architecture §9). */
export const PAIRING_CODE_LENGTH = 6;
export const PAIRING_CODE_TTL_MS = 10 * 60_000;
/** Unambiguous uppercase alphabet — no 0/O, 1/I. */
const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** The settings contract is core's (#227): one shape for the actor, the pages and the router (`defaults.environmentId`, AGT-05). */
export type { NotificationPrefs, RetentionSettings, WorkspaceDefaults, WorkspaceSettings };

export const DEFAULT_SETTINGS: WorkspaceSettings = DEFAULT_WORKSPACE_SETTINGS;

export type MachineStatus = 'pending' | 'paired';

/** The Workspace's view of a machine; the Machine actor holds the rest. */
export interface MachineIndexEntry {
    readonly id: MachineId;
    readonly name: string;
    readonly status: MachineStatus;
    readonly registeredAt: number;
    readonly pairedAt?: number;
    /** Present only while `status === 'pending'`. */
    readonly pairing?: { readonly code: string; readonly expiresAt: number };
}

/** The last run of one OPS-10 task. `finishedAt` without `error` is success. */
export interface WorkspaceOpRecord {
    readonly startedAt: number;
    readonly finishedAt?: number;
    readonly error?: string;
    /** Export only: the `{ws}/{stamp}` prefix the files went under. */
    readonly prefix?: string;
    /** Export: files written; delete: records purged. */
    readonly count?: number;
}

export interface WorkspaceOps {
    export?: WorkspaceOpRecord;
    delete?: WorkspaceOpRecord;
}

/** One folder work ran in lately (#190): what the folder picker offers first. */
export interface RecentWorkdir extends WorkdirRef {
    /** When it was last chosen. */
    readonly at: number;
}

/** `recentWorkdirs` keeps at most this many, most recent first. */
export const RECENT_WORKDIRS_MAX = 20;

/** A project's name is one line of at most this many characters; `upsertProject` collapses whitespace and rejects the rest. */
export const MAX_PROJECT_NAME_LENGTH = 120;

export interface WorkspaceState {
    v: number;
    /** The owning user; the key's `{userId}` segment. */
    owner: string;
    createdAt: number;
    agents: AgentId[];
    chats: ChatId[];
    machines: MachineIndexEntry[];
    schedules: ScheduleId[];
    settings: WorkspaceSettings;
    /** OPS-10 task log; absent on records written before it existed. */
    ops?: WorkspaceOps;
    /** Folders chosen for work lately (#190), most recent first, one per `{environmentId, path}`, at most `RECENT_WORKDIRS_MAX`; absent on older records. */
    recentWorkdirs?: RecentWorkdir[];
    /** The workspace's projects (#330/#332), creation order, at most `PROJECTS_MAX`; absent on older records. */
    projects?: ProjectRecord[];
    /** The project last chosen for a chat (`createChat({ projectId })`, `noteProject`): what the New chat picker preselects. Absent until one is; cleared when that project is removed. */
    lastProjectId?: ProjectId;
    /** The machine last chosen for a chat (`createChat({ machineId })`, `noteMachine`, #414): what the New chat picker preselects. Absent until one is; cleared when that machine is removed. */
    lastMachineId?: MachineId;
}

/** What `get` returns: the state, detached from the actor. */
export type WorkspaceView = Readonly<WorkspaceState>;

export interface CreateAgentInput {
    readonly name: string;
}

export interface CreateChatInput {
    readonly title?: string;
    /** The project the new chat belongs to (#332): written to the chat over a hop (`Chat.setProject`) after the index save, and noted as the last used. */
    readonly projectId?: ProjectId;
    /** The machine the new chat runs on (#414): written over a hop (`Chat.setMachine`) after the project, and noted as the last used. */
    readonly machineId?: MachineId;
}

export interface RegisterMachineInput {
    readonly name: string;
}

export interface RegisterMachineResult {
    readonly machineId: MachineId;
    readonly pairingCode: string;
    readonly expiresAt: number;
}

/** A one-level-deep partial for `updateSettings`. */
export interface SettingsPatch {
    readonly timeZone?: string;
    readonly notifications?: Partial<NotificationPrefs>;
    readonly defaults?: Partial<WorkspaceDefaults>;
    readonly retention?: Partial<RetentionSettings>;
    /** The channel and policy machines follow unless given their own (#365); absent in the settings means `DEFAULT_UPDATE_SETTINGS`. */
    readonly updates?: Partial<UpdateSettings>;
}

export interface WorkspaceOptions {
    /** Where `exportAll` writes (R2 on Cloudflare). */
    readonly sink?: ArtifactSink;
    /** How `deleteAll` reaches child records (the actor storage). */
    readonly store?: WorkspaceStore;
    /** Where chat attachment bytes live (#203): `deleteAll` deletes every chat's files (`ChatFileStore.deleteChat`). */
    readonly files?: ChatFileStore;
    readonly now?: () => number;
    /** Override the policy chain. Default `[sameWorkspace, workspaceOwner]`. */
    readonly authorize?: ActorPolicy | readonly ActorPolicy[];
}

/** The `{userId}` of a `ws:{userId}` key. */
export function ownerOfWorkspaceKey(key: string): string {
    return key.startsWith(WORKSPACE_KEY_PREFIX) ? key.slice(WORKSPACE_KEY_PREFIX.length) : key;
}

export function createPairingCode(): string {
    const bytes = new Uint8Array(PAIRING_CODE_LENGTH);
    crypto.getRandomValues(bytes);
    let out = '';
    for (const b of bytes) out += PAIRING_ALPHABET[b % PAIRING_ALPHABET.length];
    return out;
}

/** Same amount of work whatever the first mismatch is. */
function codesMatch(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * A Machine definition to hop with for the environment directory (`upsertProject`): the host resolves the target
 * by `type`, so the app's `defineMachineActor` instance answers and this one's ports never run. Built lazily —
 * `machine/actor.ts` imports this module, and a top-level call would hit the cycle before it settles.
 */
let machineRef: AnyActorDefinition | undefined;
const machineRefDef = (): AnyActorDefinition => (machineRef ??= defineMachineActor({ socket: { send: () => false, close: () => undefined } }));

interface MachineGetClient {
    get(): Promise<MachineView>;
}

/** The daemon's path rules; one that never said is taken for Windows, the first platform (decision 2). */
const osOf = (m: MachineView): HostOs => m.os ?? 'windows';

const bad = (message: string): never => {
    throw new ServerFnError(400, `Workspace.upsertProject: ${message}`);
};

/**
 * The `folders` of a project after `patch.folders` — `null` removes an entry — with every folder the patch sets
 * checked against its environment's roots through the paired machines' reports (the same directory the router
 * scans, `routing/locate.ts`): a folder no machine can run in is never stored.
 */
async function checkedFolders(ctx: ActorContext<WorkspaceState>, base: ProjectRecord['folders'] | undefined, patch: ProjectPatch['folders']): Promise<Record<string, string>> {
    const folders: Record<string, string> = {};
    for (const [environmentId, path] of Object.entries(base ?? {})) if (typeof path === 'string') folders[environmentId] = path;
    if (patch === undefined) return folders;
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) bad('folders must be an object keyed by environment id');
    const workspaceId = ownerOfWorkspaceKey(ctx.key) as WorkspaceId;
    let machines: MachineView[] | undefined;
    const environment = async (environmentId: EnvironmentId): Promise<{ env: EnvironmentDescriptor; os: HostOs } | null> => {
        if (!machines) {
            machines = [];
            for (const entry of ctx.state.machines) {
                if (entry.status !== 'paired') continue;
                try {
                    machines.push(await (ctx.actor(machineRefDef(), machineKey(workspaceId, entry.id)) as unknown as MachineGetClient).get());
                } catch {
                    // A machine that cannot be read reports no environment.
                }
            }
        }
        for (const m of machines) {
            const env = m.environments.find((e) => e.id === environmentId);
            if (env) return { env, os: osOf(m) };
        }
        return null;
    };
    for (const [environmentId, path] of Object.entries(patch)) {
        if (path === undefined) continue;
        if (!environmentId.trim()) bad('an environment id is required for every folder');
        if (path === null) {
            delete folders[environmentId];
            continue;
        }
        if (typeof path !== 'string' || !path.trim()) bad(`the folder for environment ${environmentId} must be a path`);
        const folder = path.trim();
        const found = await environment(environmentId as EnvironmentId);
        if (!found) bad(`no machine of the workspace reports environment ${environmentId}`);
        if (!pathWithin(folder, found!.env.cwdRoots, found!.os)) bad(`folder ${folder} is outside the roots of environment ${environmentId} (${found!.env.cwdRoots.join(', ') || 'none'})`);
        folders[environmentId] = folder;
    }
    return folders;
}

/** `members` as stored: every agent of the workspace, the coordinator one of them or none. */
function checkedMembers(state: WorkspaceState, members: ProjectMembers | undefined, base: ProjectMembers | undefined): ProjectMembers {
    if (members === undefined) return base ?? { agentIds: [], coordinator: null };
    if (members === null || typeof members !== 'object' || !Array.isArray(members.agentIds)) bad('members must be { agentIds, coordinator }');
    const agentIds = [...new Set(members.agentIds)];
    for (const id of agentIds) {
        if (typeof id !== 'string' || !state.agents.includes(id)) bad(`${String(id)} is not an agent of this workspace`);
    }
    const coordinator = members.coordinator ?? null;
    if (coordinator !== null && !agentIds.includes(coordinator)) bad(`the coordinator ${String(coordinator)} must be one of the members`);
    return { agentIds, coordinator };
}

/** `connectors` as stored: refs with an id, one per id. */
function checkedConnectors(connectors: readonly ConnectorRef[] | undefined, base: readonly ConnectorRef[] | undefined): ConnectorRef[] {
    if (connectors === undefined) return [...(base ?? [])];
    if (!Array.isArray(connectors)) bad('connectors must be an array');
    const out: ConnectorRef[] = [];
    for (const c of connectors) {
        if (c === null || typeof c !== 'object' || typeof c.id !== 'string' || !c.id.trim()) bad('every connector needs an id');
        if (!out.some((x) => x.id === c.id)) out.push({ id: c.id });
    }
    return out;
}

/** `features` after `patch.features` — `null` removes one — each settings object checked by the Registry (`checkProjectSettings`) over a hop. */
async function checkedFeatures(ctx: ActorContext<WorkspaceState>, base: ProjectFeatures | undefined, patch: ProjectPatch['features']): Promise<Record<string, Record<string, unknown>>> {
    const features: Record<string, Record<string, unknown>> = {};
    for (const [id, settings] of Object.entries(base ?? {})) features[id] = { ...settings };
    if (patch === undefined) return features;
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) bad('features must be an object keyed by plugin id');
    const registry = ctx.actor(Registry, registryKey(ownerOfWorkspaceKey(ctx.key)));
    for (const [id, settings] of Object.entries(patch)) {
        if (!id.trim()) bad('a plugin id is required for every feature');
        if (settings === null) {
            delete features[id];
            continue;
        }
        if (typeof settings !== 'object' || Array.isArray(settings)) bad(`the settings of feature ${id} must be an object`);
        try {
            await registry.checkProjectSettings(id, settings);
        } catch (error) {
            bad(`feature ${id}: ${errorText(error)}`);
        }
        features[id] = { ...settings };
    }
    return features;
}

export function defineWorkspace(options: WorkspaceOptions = {}) {
    // Resolved per call, not captured: tests replace `Date.now` after this module loaded.
    const now = options.now ?? (() => Date.now());
    const authorize: ActorPolicy | readonly ActorPolicy[] = options.authorize ?? [sameWorkspace, workspaceOwner];
    const cascade = { ...(options.sink ? { sink: options.sink } : {}), ...(options.store ? { store: options.store } : {}), ...(options.files ? { files: options.files } : {}), now };

    return defineActor({
        type: 'Workspace',
        authorize,
        persistence: 'explicit',
        // `projects` interleaves: `Chat.setProject` reads it back over a hop inside `createChat`'s own turn.
        methodReentrancy: { get: 'always', recentWorkdirs: 'always', projects: 'always', listMachines: 'always' },
        state: (key): WorkspaceState => ({
            v: WORKSPACE_STATE_VERSION,
            owner: ownerOfWorkspaceKey(key),
            createdAt: now(),
            agents: [],
            chats: [],
            machines: [],
            schedules: [],
            settings: DEFAULT_SETTINGS,
            ops: {}
        }),
        methods: (ctx) => ({
            async get(): Promise<WorkspaceView> {
                return ctx.snapshot();
            },

            /** Records the id in the index; the Agent actor's config is written by the Agent lane. */
            async createAgent(input: CreateAgentInput): Promise<{ agentId: AgentId }> {
                if (!input.name.trim()) throw new Error('[Workspace] createAgent: name is required');
                const agentId = createId('agent') as AgentId;
                ctx.state.agents.push(agentId);
                await ctx.save();
                return { agentId };
            },

            /**
             * Records the id in the index and, when a title is given, writes it to
             * the Chat actor over a hop (#124) — the chat's own `rename` entry, so
             * `Chat.get().title` carries it; a project (#332) goes the same way
             * (`Chat.setProject`, after the title) and is noted as the last used,
             * and so does a machine (#414, `Chat.setMachine`, after the project).
             * The index entry is saved first: a hop that fails leaves an untitled,
             * project-less, machine-less chat, never an orphan. An unknown project,
             * or a machine the index does not list as paired, is a 400 before
             * anything is written.
             */
            async createChat(input: CreateChatInput = {}): Promise<{ chatId: ChatId }> {
                const projectId = input.projectId;
                if (projectId !== undefined && !(ctx.state.projects ?? []).some((p) => p.id === projectId)) throw new ServerFnError(400, `Workspace.createChat: no project ${String(projectId)} in this workspace`);
                const machineId = input.machineId;
                if (machineId !== undefined && !ctx.state.machines.some((m) => m.id === machineId && m.status === 'paired')) throw new ServerFnError(400, `Workspace.createChat: no paired machine ${String(machineId)} in this workspace`);
                const chatId = createId('chat') as ChatId;
                ctx.state.chats.push(chatId);
                await ctx.save();
                const chat = ctx.actor(Chat, actorKey(ownerOfWorkspaceKey(ctx.key) as WorkspaceId, 'chat', chatId));
                const title = input.title?.trim();
                if (title) await chat.rename(title);
                if (projectId !== undefined) {
                    await chat.setProject(projectId);
                    // Noted only once the chat is in the project: a failed hop must not preselect a project no chat got.
                    ctx.state.lastProjectId = projectId;
                    await ctx.save();
                }
                if (machineId !== undefined) {
                    await chat.setMachine(machineId);
                    ctx.state.lastMachineId = machineId;
                    await ctx.save();
                }
                return { chatId };
            },

            /** The workspace's projects (#332), creation order. Interleaves with writes. */
            async projects(): Promise<readonly ProjectRecord[]> {
                return ctx.snapshot(ctx.state.projects ?? []);
            },

            /**
             * Create a project (no `id`; `name` required) or change one (#332), per the
             * `ProjectPatch` contract: a `null` folder, feature or description removes it,
             * fields left out are kept. Every folder the patch sets must be absolute and
             * inside its environment's `cwdRoots` as a paired machine reports them — an
             * environment nobody reports is refused; every member must be an agent of the
             * workspace, the coordinator one of them; every feature's settings must pass
             * its plugin's `projectSettings` (`Registry.checkProjectSettings`). 400 on any
             * of these, 404 for an unknown `id`, 400 for the `PROJECTS_MAX + 1`th project.
             * One save; recorded as `project.changed`.
             */
            async upsertProject(patch: ProjectPatch): Promise<ProjectRecord> {
                if (patch === null || typeof patch !== 'object') bad('a patch is required');
                const projects = ctx.state.projects ?? [];
                let base: ProjectRecord | undefined;
                if (patch.id !== undefined) {
                    base = projects.find((p) => p.id === patch.id);
                    if (!base) throw new ServerFnError(404, `Workspace.upsertProject: no project ${String(patch.id)} in this workspace`);
                } else if (projects.length >= PROJECTS_MAX) {
                    bad(`a workspace holds at most ${PROJECTS_MAX} projects`);
                }
                const name = patch.name !== undefined ? (typeof patch.name === 'string' ? patch.name.replace(/\s+/g, ' ').trim() : '') : base?.name;
                if (!name) bad('a name is required');
                if (name!.length > MAX_PROJECT_NAME_LENGTH) bad(`the name is longer than ${MAX_PROJECT_NAME_LENGTH} characters`);
                let description = patch.description === null ? undefined : patch.description === undefined ? base?.description : typeof patch.description === 'string' ? patch.description.trim() : bad('the description must be text');
                if (description === '') description = undefined;
                const members = checkedMembers(ctx.state, patch.members, base?.members);
                const connectors = checkedConnectors(patch.connectors, base?.connectors);
                const folders = await checkedFolders(ctx, base?.folders, patch.folders);
                const features = await checkedFeatures(ctx, base?.features, patch.features);
                // The hops awaited: the record may have moved meanwhile (a concurrent remove, a `get` interleaving is read-only).
                const current = ctx.state.projects ?? [];
                if (base && !current.some((p) => p.id === base!.id)) throw new ServerFnError(404, `Workspace.upsertProject: project ${base.id} was removed meanwhile`);
                const at = now();
                const record: ProjectRecord = {
                    id: base?.id ?? (createId('project') as ProjectId),
                    name: name!,
                    ...(description !== undefined ? { description } : {}),
                    members,
                    folders: folders as ProjectRecord['folders'],
                    connectors,
                    features,
                    createdAt: base?.createdAt ?? at,
                    updatedAt: at
                };
                ctx.state.projects = base ? current.map((p) => (p.id === record.id ? record : p)) : [...current, record];
                await ctx.save();
                await recordAudit(ctx, ownerOfWorkspaceKey(ctx.key) as WorkspaceId, {
                    key: `${ctx.key}:project:${record.id}:${at}`,
                    kind: 'project.changed',
                    at,
                    by: `user:${ctx.state.owner}`,
                    summary: `project ${record.name} (${record.id}) ${base ? 'updated' : 'created'}`,
                    data: { projectId: record.id, name: record.name, op: base ? 'updated' : 'created' }
                });
                return ctx.snapshot(record);
            },

            /**
             * Remove a project (#332): 404 when unknown; clears `lastProjectId` when it was
             * this one. Chats keep pointing at the id — the router fails their tasks
             * `project-missing` and the web shows a removed project (decisions 2026-09-20).
             */
            async removeProject(projectId: ProjectId): Promise<void> {
                const projects = ctx.state.projects ?? [];
                const removed = projects.find((p) => p.id === projectId);
                if (!removed) throw new ServerFnError(404, `Workspace.removeProject: no project ${String(projectId)} in this workspace`);
                ctx.state.projects = projects.filter((p) => p.id !== projectId);
                if (ctx.state.lastProjectId === projectId) delete ctx.state.lastProjectId;
                await ctx.save();
                const at = now();
                await recordAudit(ctx, ownerOfWorkspaceKey(ctx.key) as WorkspaceId, {
                    key: `${ctx.key}:project:${projectId}:${at}`,
                    kind: 'project.changed',
                    at,
                    by: `user:${ctx.state.owner}`,
                    summary: `project ${removed.name} (${projectId}) removed`,
                    data: { projectId, name: removed.name, op: 'removed' }
                });
            },

            /** Remember the project last used for a chat (#332) — `get().lastProjectId` — or forget it with `null`. 400 for an unknown id. */
            async noteProject(projectId: ProjectId | null): Promise<void> {
                if (projectId !== null && !(ctx.state.projects ?? []).some((p) => p.id === projectId)) throw new ServerFnError(400, `Workspace.noteProject: no project ${String(projectId)} in this workspace`);
                if (projectId === null) delete ctx.state.lastProjectId;
                else ctx.state.lastProjectId = projectId;
                await ctx.save();
            },

            /** Remember the machine last used for a chat (#414) — `get().lastMachineId` — or forget it with `null`. 400 for a machine the index does not list as paired. */
            async noteMachine(machineId: MachineId | null): Promise<void> {
                if (machineId !== null && !ctx.state.machines.some((m) => m.id === machineId && m.status === 'paired')) throw new ServerFnError(400, `Workspace.noteMachine: no paired machine ${String(machineId)} in this workspace`);
                if (machineId === null) delete ctx.state.lastMachineId;
                else ctx.state.lastMachineId = machineId;
                await ctx.save();
            },

            /** Allocates and indexes a schedule id; the caller then `create`s the Schedule actor under it. */
            async createSchedule(): Promise<{ scheduleId: ScheduleId }> {
                const scheduleId = createId('schedule') as ScheduleId;
                ctx.state.schedules.push(scheduleId);
                await ctx.save();
                return { scheduleId };
            },

            async removeSchedule(scheduleId: ScheduleId): Promise<boolean> {
                const i = ctx.state.schedules.indexOf(scheduleId);
                if (i < 0) return false;
                ctx.state.schedules.splice(i, 1);
                await ctx.save();
                return true;
            },

            /**
             * Register a machine that has not paired yet. The daemon presents the
             * code to `POST /auth/pair`, which finds the workspace through the
             * global `PairingDirectory` (filed here over a hop, #37) and calls
             * `Machine.pair`, which redeems the code here through another hop;
             * the machine token itself is minted by the auth lane, never stored here.
             */
            async registerMachinePending(input: RegisterMachineInput): Promise<RegisterMachineResult> {
                if (!input.name.trim()) throw new Error('[Workspace] registerMachinePending: name is required');
                const machineId = createId('machine') as MachineId;
                const at = now();
                const pairing = { code: createPairingCode(), expiresAt: at + PAIRING_CODE_TTL_MS };
                // The directory is the door; this record is the proof. Filed first: a directory entry without a record is a
                // harmless 401 that expires, a record without a directory entry would be a code nobody can present.
                await ctx.actor(PairingDirectory, PAIRING_DIRECTORY_KEY).register(pairing.code, { workspaceId: ownerOfWorkspaceKey(ctx.key) as WorkspaceId, machineId, expiresAt: pairing.expiresAt });
                ctx.state.machines.push({ id: machineId, name: input.name, status: 'pending', registeredAt: at, pairing });
                await ctx.save();
                return { machineId, pairingCode: pairing.code, expiresAt: pairing.expiresAt };
            },

            /**
             * Redeem a pairing code: single use, expiring. Returns the machine it
             * belonged to, or `null` for an unknown, used or expired code — the
             * caller cannot tell which, by design. An expired entry is dropped.
             */
            async claimPairing(code: string): Promise<{ machineId: MachineId } | null> {
                const at = now();
                const i = ctx.state.machines.findIndex((m) => m.pairing !== undefined && codesMatch(m.pairing.code, code));
                if (i < 0) return null;
                const entry = ctx.state.machines[i]!;
                if (entry.pairing!.expiresAt <= at) {
                    ctx.state.machines.splice(i, 1);
                    await ctx.save();
                    return null;
                }
                ctx.state.machines[i] = { id: entry.id, name: entry.name, status: 'paired', registeredAt: entry.registeredAt, pairedAt: at };
                await ctx.save();
                return { machineId: entry.id };
            },

            /** Every machine, without the pairing codes — those were shown once, at registration. */
            async listMachines(): Promise<readonly MachineIndexEntry[]> {
                return ctx.state.machines.map((m) => {
                    const { pairing: _pairing, ...rest } = ctx.snapshot(m);
                    return rest;
                });
            },

            /** Drops the index entry; clears `lastMachineId` when it was this one (chats keep the dangling id, as with a removed project). */
            async removeMachine(machineId: MachineId): Promise<boolean> {
                const i = ctx.state.machines.findIndex((m) => m.id === machineId);
                if (i < 0) return false;
                ctx.state.machines.splice(i, 1);
                if (ctx.state.lastMachineId === machineId) delete ctx.state.lastMachineId;
                await ctx.save();
                return true;
            },

            /**
             * Remember a folder work was started in (#190): it moves to the front of
             * `recentWorkdirs` (one entry per environment and path), which keeps the
             * newest `RECENT_WORKDIRS_MAX`. The router notes a task's own `workdir`
             * over a one-way hop; the UI may note a pick too.
             */
            async noteWorkdir(ref: WorkdirRef): Promise<readonly RecentWorkdir[]> {
                if (typeof ref?.environmentId !== 'string' || !ref.environmentId.trim() || typeof ref.path !== 'string' || !ref.path.trim()) {
                    throw new ServerFnError(400, 'Workspace.noteWorkdir: a folder needs an environmentId and a path');
                }
                // Trimmed, so two notes of one folder are one row.
                const entry: RecentWorkdir = { environmentId: ref.environmentId.trim() as WorkdirRef['environmentId'], path: ref.path.trim(), at: now() };
                const rest = (ctx.state.recentWorkdirs ?? []).filter((r) => r.environmentId !== entry.environmentId || r.path !== entry.path);
                ctx.state.recentWorkdirs = [entry, ...rest].slice(0, RECENT_WORKDIRS_MAX);
                await ctx.save();
                return ctx.snapshot(ctx.state.recentWorkdirs);
            },

            /** The folders work was started in lately, most recent first (#190). */
            async recentWorkdirs(): Promise<readonly RecentWorkdir[]> {
                return ctx.snapshot(ctx.state.recentWorkdirs ?? []);
            },

            async updateSettings(patch: SettingsPatch): Promise<WorkspaceSettings> {
                const s = ctx.state.settings;
                // Rebuilt field by field: a record written before #230 may still carry `defaults.model`, which is the runtime plugin's to say now.
                const defaults = { ...s.defaults, ...patch.defaults };
                // Updates (#365): kept only once set, so a workspace that never chose follows `DEFAULT_UPDATE_SETTINGS` as it moves.
                let updates = s.updates;
                if (patch.updates) {
                    const base = s.updates ?? DEFAULT_UPDATE_SETTINGS;
                    try {
                        updates = {
                            defaultChannel: patch.updates.defaultChannel === undefined ? base.defaultChannel : checkChannel(patch.updates.defaultChannel),
                            defaultPolicy: patch.updates.defaultPolicy === undefined ? base.defaultPolicy : checkUpdatePolicy(patch.updates.defaultPolicy)
                        };
                    } catch (e) {
                        throw new ServerFnError(400, `Workspace.updateSettings: ${e instanceof Error ? e.message : String(e)}`);
                    }
                }
                ctx.state.settings = {
                    timeZone: patch.timeZone ?? s.timeZone,
                    notifications: { ...s.notifications, ...patch.notifications },
                    defaults: { runtime: defaults.runtime, ...(defaults.environmentId ? { environmentId: defaults.environmentId } : {}) },
                    retention: { ...s.retention, ...patch.retention },
                    ...(updates ? { updates } : {})
                };
                await ctx.save();
                return ctx.snapshot(ctx.state.settings);
            },

            /** OPS-10: write everything as NDJSON through the `ArtifactSink`. Progress lands in `get().ops.export`. */
            async exportAll(): Promise<{ started: true }> {
                ctx.state.ops = { ...ctx.state.ops, export: { startedAt: now() } };
                await ctx.save();
                await ctx.tasks.start('exportAll');
                return { started: true };
            },

            /** OPS-10: purge every child record, then this one. `get()` afterwards is a fresh workspace. */
            async deleteAll(): Promise<{ started: true }> {
                ctx.state.ops = { ...ctx.state.ops, delete: { startedAt: now() } };
                await ctx.save();
                await ctx.tasks.start('deleteAll');
                return { started: true };
            }
        }),
        tasks: (ctx) => ({
            async exportAll(): Promise<void> {
                const startedAt = (await ctx.turn((c) => c.snapshot())).ops?.export?.startedAt ?? now();
                let record: WorkspaceOpRecord;
                try {
                    const report = await exportWorkspace(ctx, cascade);
                    record = { startedAt, finishedAt: now(), prefix: report.prefix, count: report.files.length };
                } catch (error) {
                    record = { startedAt, finishedAt: now(), error: errorText(error) };
                }
                await ctx.turn(async (c) => {
                    c.state.ops = { ...c.state.ops, export: record };
                    await c.save();
                });
            },
            async deleteAll(): Promise<void> {
                const startedAt = (await ctx.turn((c) => c.snapshot())).ops?.delete?.startedAt ?? now();
                try {
                    await deleteWorkspace(ctx, cascade);
                    // Success leaves nothing to write to: the record is gone.
                } catch (error) {
                    await ctx.turn(async (c) => {
                        c.state.ops = { ...c.state.ops, delete: { startedAt, finishedAt: now(), error: errorText(error) } };
                        await c.save();
                    });
                }
            }
        })
    });
}

/** The Workspace with no ports: everything but the OPS-10 tasks. The app registers `defineWorkspace({ sink, store })`. */
export const Workspace = defineWorkspace();

export type WorkspaceActor = ReturnType<typeof defineWorkspace>;

export type { ActorRecordRef, ArtifactSink, WorkspaceStore } from './ports.js';
export { childRecords, deleteWorkspace, exportWorkspace, type CascadeOptions, type DeleteReport, type ExportReport } from './cascade.js';
