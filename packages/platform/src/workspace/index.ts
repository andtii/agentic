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

import type { AgentConfig, AgentId, ChatFileStore, ChatId, ConnectorRef, HostOs, MachineId, NotificationPrefs, ProjectColor, ProjectFeatures, ProjectId, ProjectManagerSpec, ProjectMembers, PmPolicy, ProjectPatch, ProjectRecord, RetentionSettings, ScheduleId, UpdateSettings, WorkdirRef, WorkspaceDefaults, WorkspaceId, WorkspaceSettings } from '@agentic/core';
import { actorKey, createId, DEFAULT_UPDATE_SETTINGS, DEFAULT_WORKSPACE_SETTINGS, MEMBER_LIMIT_MAX, parseProjectFolderKey, pathWithin, PROJECT_COLORS, PROJECTS_MAX } from '@agentic/core';
import { defineActor, type ActorContext, type ActorPolicy, type AnyActorDefinition } from '@sigx/actors';
import { ServerFnError } from '@sigx/server';
import type { ProjectChangedData } from '../audit/events.js';
import { recordAudit } from '../audit/port.js';
import { AgentActor, agentKey } from '../agent/agent.actor.js';
import type { AgentVersionInfo } from '../agent/entries.js';
import { sameWorkspace, workspaceOwner, WORKSPACE_KEY_PREFIX } from '../auth/index.js';
import { Chat } from '../chat/index.js';
import { defineMachineActor, machineKey, type MachineView } from '../machine/index.js';
import { checkPolicyRoots } from '../machine/policy.js';
import { checkChannel, checkUpdatePolicy } from '../machine/update.js';
import { PAIRING_DIRECTORY_KEY, PairingDirectory } from '../pairing/directory.js';
import { Registry } from '../registry/actor.js';
import { registryKey } from '../registry/key.js';
import { deleteWorkspace, exportWorkspace } from './cascade.js';
import type { ArtifactSink, WorkspaceStore } from './ports.js';
import { checkedPmSpec, DEFAULT_PM_SPEC, pmCoordinatorError, PmSpecError, projectManagerConfig, projectManagerConfigPatch, withProjectManager, type ProjectManagerPatch } from './project-manager.js';
import { checkedPmPolicy } from './pm-policy.js';

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
    /** Present only while `status === 'pending'`. `allowedRoots` (#480): the folders the Pair page preset, handed to the Machine when the code is claimed. */
    readonly pairing?: { readonly code: string; readonly expiresAt: number; readonly allowedRoots?: readonly string[] };
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

/** A member's role on a project (`ProjectMembers.roles`, #734) is one line of at most this many characters. */
export const MAX_PROJECT_ROLE_LENGTH = 40;

/** One project's line in `projectSummaries` (#734; PRJ-01/02): what the index cards and the sub-menu count. */
export interface ProjectSummaryLine {
    readonly projectId: ProjectId;
    /** Chats in the project that are not archived. */
    readonly openChats: number;
    /** Archived chats in the project (#774, `Chat.archive`); they are not in `openChats`. */
    readonly archivedChats: number;
    /** The newest entry's `at` across the project's open chats; absent while none has one. */
    readonly lastActivityAt?: number;
}

/** What `projectSummaries` returns: one line per project in creation order, and the chats outside any project. */
export interface ProjectSummaries {
    readonly projects: readonly ProjectSummaryLine[];
    /** Open chats in no project, or in one the workspace no longer has (the "outside any project" strip); archived ones are left out. */
    readonly unassigned: { readonly openChats: number; readonly lastActivityAt?: number };
}

/** The project keys an upsert is audited by (`project.changed` data `changed`). */
const PROJECT_KEYS = ['name', 'description', 'members', 'folders', 'connectors', 'features', 'color'] as const;

/** How many chats `projectSummaries` reads at once. */
const SUMMARY_CONCURRENCY = 8;

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
    /** The folders the web may use on the machine once it pairs (#480): `~` forms or absolute paths, ≤ 32. The Pair page's default is `['~']`. */
    readonly allowedRoots?: readonly string[];
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

interface MachineRevokeClient {
    revoke(): Promise<MachineView>;
}

/** The daemon's path rules; one that never said is taken for Windows, the first platform (decision 2). */
const osOf = (m: MachineView): HostOs => m.os ?? 'windows';

const bad = (message: string): never => {
    throw new ServerFnError(400, `Workspace.upsertProject: ${message}`);
};

/** `fn()`, with a `PmSpecError` answered as a 400 from `method` (#784). */
function pmChecked<T>(method: string, fn: () => T): T {
    try {
        return fn();
    } catch (error) {
        if (error instanceof PmSpecError) throw new ServerFnError(400, `Workspace.${method}: ${error.message}`);
        throw error;
    }
}

/**
 * The `folders` of a project after `patch.folders` — `null` removes an entry — with every folder the patch sets
 * checked through the paired machine it names (#702: environment ids are only unique per machine). A machine's
 * folder (`<machineId>/*`) must be inside the roots of at least one of its environments — the others simply do not
 * inherit it; an override (`<machineId>/<environmentId>`) must be inside that environment's roots. A pre-#702 key
 * (a bare environment id) is kept and may be removed, never set: a folder no machine can run in is never stored.
 */
async function checkedFolders(ctx: ActorContext<WorkspaceState>, base: ProjectRecord['folders'] | undefined, patch: ProjectPatch['folders']): Promise<Record<string, string>> {
    const folders: Record<string, string> = {};
    for (const [key, path] of Object.entries(base ?? {})) if (typeof path === 'string') folders[key] = path;
    if (patch === undefined) return folders;
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) bad('folders must be an object keyed by <machineId>/* or <machineId>/<environmentId>');
    const workspaceId = ownerOfWorkspaceKey(ctx.key) as WorkspaceId;
    const machines = new Map<MachineId, MachineView | null>();
    const machineOf = async (machineId: MachineId): Promise<MachineView | null> => {
        if (!machines.has(machineId)) {
            let view: MachineView | null = null;
            if (ctx.state.machines.some((m) => m.id === machineId && m.status === 'paired')) {
                try {
                    view = await (ctx.actor(machineRefDef(), machineKey(workspaceId, machineId)) as unknown as MachineGetClient).get();
                } catch {
                    // A machine that cannot be read reports no environment.
                }
            }
            machines.set(machineId, view);
        }
        return machines.get(machineId)!;
    };
    for (const [key, path] of Object.entries(patch)) {
        if (path === undefined) continue;
        const parsed = parseProjectFolderKey(key);
        if (!parsed) bad(`${key} is not a folder key: use <machineId>/* or <machineId>/<environmentId>`);
        if (path === null) {
            delete folders[key];
            continue;
        }
        if (parsed!.legacy) bad(`key folders by machine: ${key} is a bare environment id, use <machineId>/* or <machineId>/${key}`);
        if (typeof path !== 'string' || !path.trim()) bad(`the folder for ${key} must be a path`);
        const folder = path.trim();
        const m = await machineOf(parsed!.machineId!);
        if (!m) bad(`machine ${parsed!.machineId} is not a paired machine of the workspace`);
        const environmentId = parsed!.environmentId;
        if (environmentId !== undefined) {
            const env = m!.environments.find((e) => e.id === environmentId);
            if (!env) bad(`machine ${m!.name} reports no environment ${environmentId}`);
            if (!pathWithin(folder, env!.cwdRoots, osOf(m!))) bad(`folder ${folder} is outside the roots of environment ${environmentId} on machine ${m!.name} (${env!.cwdRoots.join(', ') || 'none'})`);
        } else if (!m!.environments.some((e) => pathWithin(folder, e.cwdRoots, osOf(m!)))) {
            const roots = [...new Set(m!.environments.flatMap((e) => e.cwdRoots))];
            bad(`folder ${folder} is outside the roots of every environment on machine ${m!.name} (${roots.join(', ') || 'none'})`);
        }
        folders[key] = folder;
    }
    return folders;
}

/**
 * `members` as stored: every agent of the workspace, the coordinator one of them or none; `roles` one line each and
 * `limits` whole numbers 1…`MEMBER_LIMIT_MAX`, both keyed by members only (#734). `roles` / `limits` left out keep the
 * base's entries for the agents that are still members; an empty role drops the entry.
 */
function checkedMembers(state: WorkspaceState, members: ProjectMembers | undefined, base: ProjectMembers | undefined): ProjectMembers {
    if (members === undefined) return base ?? { agentIds: [], coordinator: null };
    if (members === null || typeof members !== 'object' || !Array.isArray(members.agentIds)) bad('members must be { agentIds, coordinator }');
    const agentIds = [...new Set(members.agentIds)];
    for (const id of agentIds) {
        if (typeof id !== 'string' || !state.agents.includes(id)) bad(`${String(id)} is not an agent of this workspace`);
    }
    const coordinator = members.coordinator ?? null;
    if (coordinator !== null && !agentIds.includes(coordinator)) bad(`the coordinator ${String(coordinator)} must be one of the members`);
    const isMember = (id: string): boolean => (agentIds as string[]).includes(id);
    const perMember = (given: unknown, kept: Readonly<Partial<Record<AgentId, unknown>>> | undefined, what: string): [string, unknown][] => {
        if (given === undefined) return Object.entries(kept ?? {}).filter(([id, v]) => v !== undefined && isMember(id));
        if (given === null || typeof given !== 'object' || Array.isArray(given)) bad(`${what} must be an object keyed by member agent id`);
        const entries = Object.entries(given as Record<string, unknown>).filter(([, v]) => v !== undefined);
        for (const [id] of entries) if (!isMember(id)) bad(`${what}: ${id} is not a member of the project`);
        return entries;
    };
    const roles: Record<string, string> = {};
    for (const [id, role] of perMember(members.roles, base?.roles, 'roles')) {
        if (typeof role !== 'string') bad(`the role of ${id} must be text`);
        const text = (role as string).replace(/\s+/g, ' ').trim();
        if (text.length > MAX_PROJECT_ROLE_LENGTH) bad(`the role of ${id} is longer than ${MAX_PROJECT_ROLE_LENGTH} characters`);
        if (text) roles[id] = text;
    }
    const limits: Record<string, number> = {};
    for (const [id, limit] of perMember(members.limits, base?.limits, 'limits')) {
        if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MEMBER_LIMIT_MAX) bad(`the limit of ${id} must be a whole number from 1 to ${MEMBER_LIMIT_MAX}`);
        limits[id] = limit as number;
    }
    return { agentIds, coordinator, ...(Object.keys(roles).length ? { roles } : {}), ...(Object.keys(limits).length ? { limits } : {}) };
}

/** `color` after the patch: one of `PROJECT_COLORS`; `null` clears it; left out keeps the base's. */
function checkedColor(color: ProjectPatch['color'], base: ProjectColor | undefined): ProjectColor | undefined {
    if (color === undefined) return base;
    if (color === null) return undefined;
    if (!(PROJECT_COLORS as readonly unknown[]).includes(color)) bad(`the colour must be one of ${PROJECT_COLORS.join(', ')}`);
    return color;
}

/** The keys whose value differs between `base` and `record`; for a new project, every key it sets. */
function changedKeys(base: ProjectRecord | undefined, record: ProjectRecord): string[] {
    return PROJECT_KEYS.filter((k) => (base ? JSON.stringify(base[k]) !== JSON.stringify(record[k]) : record[k] !== undefined));
}

/** `fn` over `items`, at most `limit` at a time. */
async function eachLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < items.length) await fn(items[next++]!);
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
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
        methodReentrancy: { get: 'always', recentWorkdirs: 'always', projects: 'always', listMachines: 'always', projectSummaries: 'always' },
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
             * Per project (#734; PRJ-01/02): open and archived chat counts and the newest activity, read from each
             * chat of the index over a hop (`Chat.get` for its project, `Chat.history` for its newest entry), a few at
             * a time. A chat that cannot be read is left out. Interleaves with writes: the index is copied first.
             */
            async projectSummaries(): Promise<ProjectSummaries> {
                const projectIds = (ctx.state.projects ?? []).map((p) => p.id);
                const chatIds = [...ctx.state.chats];
                const workspaceId = ownerOfWorkspaceKey(ctx.key) as WorkspaceId;
                type Line = { openChats: number; archivedChats: number; lastActivityAt?: number };
                const unassigned: Line = { openChats: 0, archivedChats: 0 };
                const lines = new Map<ProjectId, Line>(projectIds.map((id) => [id, { openChats: 0, archivedChats: 0 }]));
                await eachLimited(chatIds, SUMMARY_CONCURRENCY, async (chatId) => {
                    const chat = ctx.actor(Chat, actorKey(workspaceId, 'chat', chatId));
                    let projectId: ProjectId | undefined;
                    let at: number | undefined;
                    let archived = false;
                    try {
                        const [summary, page] = await Promise.all([chat.get(), chat.history(null, 1)]);
                        projectId = summary.projectId;
                        archived = summary.archived === true;
                        const newest = page.entries.at(-1)?.entry as { at?: unknown } | undefined;
                        if (typeof newest?.at === 'number') at = newest.at;
                    } catch {
                        return;
                    }
                    const line = (projectId !== undefined ? lines.get(projectId) : undefined) ?? unassigned;
                    // An archived chat is counted, not shown: it adds no activity (#774).
                    if (archived) {
                        line.archivedChats += 1;
                        return;
                    }
                    line.openChats += 1;
                    if (at !== undefined && (line.lastActivityAt === undefined || at > line.lastActivityAt)) line.lastActivityAt = at;
                });
                const out = (line: Line) => ({ openChats: line.openChats, ...(line.lastActivityAt !== undefined ? { lastActivityAt: line.lastActivityAt } : {}) });
                return {
                    projects: projectIds.map((projectId) => ({ projectId, ...out(lines.get(projectId)!), archivedChats: lines.get(projectId)!.archivedChats })),
                    unassigned: out(unassigned)
                };
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
                const pmError = pmCoordinatorError(projects, base?.id, members.coordinator);
                if (pmError) bad(pmError);
                // The manager (#784): a new project gets one from `pm`, or from the default preset unless the patch opts
                // out (`pm: null`) or names its own coordinator; a change with `pm` creates or updates it, `null` unlinks it.
                const pmSpec = patch.pm === null ? null : patch.pm !== undefined ? pmChecked('upsertProject', () => checkedPmSpec(patch.pm)) : !base && (patch.members?.coordinator ?? null) === null ? DEFAULT_PM_SPEC : undefined;
                // The manager's policy (#819): checked like `setProjectPmPolicy`; the manager agent is left alone.
                const pmPolicy = patch.pmPolicy !== undefined ? pmChecked('upsertProject', () => checkedPmPolicy(patch.pmPolicy)) : undefined;
                const connectors = checkedConnectors(patch.connectors, base?.connectors);
                const folders = await checkedFolders(ctx, base?.folders, patch.folders);
                const features = await checkedFeatures(ctx, base?.features, patch.features);
                const color = checkedColor(patch.color, base?.color);
                // The hops awaited: the record may have moved meanwhile (a concurrent remove, a `get` interleaving is read-only).
                const current = ctx.state.projects ?? [];
                if (base && !current.some((p) => p.id === base!.id)) throw new ServerFnError(404, `Workspace.upsertProject: project ${base.id} was removed meanwhile`);
                const at = now();
                let record: ProjectRecord = {
                    id: base?.id ?? (createId('project') as ProjectId),
                    name: name!,
                    ...(description !== undefined ? { description } : {}),
                    members,
                    folders: folders as ProjectRecord['folders'],
                    connectors,
                    features,
                    ...(color !== undefined ? { color } : {}),
                    ...(base?.pm ? { pm: base.pm } : {}),
                    createdAt: base?.createdAt ?? at,
                    updatedAt: at
                };
                let pmConfig: AgentConfig | undefined;
                if (pmSpec) {
                    const known = record.pm?.agentId;
                    const agentId = known && ctx.state.agents.includes(known) ? known : (createId('agent') as AgentId);
                    const withPm = withProjectManager(record, agentId);
                    pmConfig = pmChecked('upsertProject', () => projectManagerConfig(withPm, pmSpec));
                    if (!ctx.state.agents.includes(agentId)) ctx.state.agents.push(agentId);
                    record = withPm;
                } else if (pmSpec === null && record.pm?.agentId) {
                    const { agentId, ...pm } = record.pm;
                    record = { ...record, members: { ...record.members, coordinator: record.members.coordinator === agentId ? null : record.members.coordinator }, pm };
                }
                if (pmPolicy) record = { ...record, pm: { ...(record.pm?.agentId ? { agentId: record.pm.agentId } : {}), policy: pmPolicy } };
                const saved = record;
                ctx.state.projects = base ? current.map((p) => (p.id === saved.id ? saved : p)) : [...current, saved];
                await ctx.save();
                // Through the Agent create path: its first (or next) config version, audited as `config.versioned`.
                if (pmConfig) await ctx.actor(AgentActor, agentKey(ownerOfWorkspaceKey(ctx.key) as WorkspaceId, saved.pm!.agentId!)).update(pmConfig, `project manager of ${saved.name}`);
                const data: ProjectChangedData = { projectId: record.id, name: record.name, op: base ? 'updated' : 'created', changed: [...changedKeys(base, record), ...(pmPolicy && JSON.stringify(base?.pm?.policy) !== JSON.stringify(pmPolicy) ? ['pm.policy'] : [])] };
                await recordAudit(ctx, ownerOfWorkspaceKey(ctx.key) as WorkspaceId, {
                    key: `${ctx.key}:project:${record.id}:${at}`,
                    kind: 'project.changed',
                    at,
                    by: `user:${ctx.state.owner}`,
                    summary: `project ${record.name} (${record.id}) ${base ? 'updated' : 'created'}`,
                    data
                });
                return ctx.snapshot(record);
            },

            /**
             * Give project `projectId` its manager (#784; PRJ-14): an agent built from `spec` (`projectManagerConfig`),
             * written through the Agent create path (index entry, then its config version, audited), set as the
             * project's coordinator and member, and recorded as `pm.agentId`. Idempotent: a project that has a manager
             * gets that agent's config updated, never a second agent. 404 for an unknown project, 400 for a bad spec.
             */
            async createProjectManager(projectId: ProjectId, spec: ProjectManagerSpec): Promise<ProjectRecord> {
                const project = (ctx.state.projects ?? []).find((p) => p.id === projectId);
                if (!project) throw new ServerFnError(404, `Workspace.createProjectManager: no project ${String(projectId)} in this workspace`);
                const checked = pmChecked('createProjectManager', () => checkedPmSpec(spec));
                const known = project.pm?.agentId;
                const agentId = known && ctx.state.agents.includes(known) ? known : (createId('agent') as AgentId);
                const record: ProjectRecord = { ...withProjectManager(project, agentId), updatedAt: now() };
                const config = pmChecked('createProjectManager', () => projectManagerConfig(record, checked));
                if (!ctx.state.agents.includes(agentId)) ctx.state.agents.push(agentId);
                ctx.state.projects = (ctx.state.projects ?? []).map((p) => (p.id === projectId ? record : p));
                await ctx.save();
                const workspaceId = ownerOfWorkspaceKey(ctx.key) as WorkspaceId;
                await ctx.actor(AgentActor, agentKey(workspaceId, agentId)).update(config, `project manager of ${record.name}`);
                const at = record.updatedAt;
                const data: ProjectChangedData = { projectId, name: record.name, op: 'updated', changed: ['members', 'pm'] };
                await recordAudit(ctx, workspaceId, {
                    key: `${ctx.key}:project:${projectId}:pm:${at}`,
                    kind: 'project.changed',
                    at,
                    by: `user:${ctx.state.owner}`,
                    summary: `project ${record.name} (${projectId}) manager ${agentId} ${known === agentId ? 'updated' : 'created'}`,
                    data
                });
                return ctx.snapshot(record);
            },

            /**
             * Change project `projectId`'s manager (#784): its name, personality or skills — a new config version of the
             * agent (AGT-06), nothing else. 404 for an unknown project, 400 for one without a manager or a bad patch.
             */
            async updateProjectManager(projectId: ProjectId, patch: ProjectManagerPatch): Promise<AgentVersionInfo> {
                const project = (ctx.state.projects ?? []).find((p) => p.id === projectId);
                if (!project) throw new ServerFnError(404, `Workspace.updateProjectManager: no project ${String(projectId)} in this workspace`);
                const agentId = project.pm?.agentId;
                if (!agentId) throw new ServerFnError(400, `Workspace.updateProjectManager: project ${project.name} has no project manager`);
                const configPatch = pmChecked('updateProjectManager', () => projectManagerConfigPatch(patch));
                const changed = Object.keys(configPatch).join(', ');
                return ctx.actor(AgentActor, agentKey(ownerOfWorkspaceKey(ctx.key) as WorkspaceId, agentId)).update(configPatch, `project manager of ${project.name}: ${changed} changed`);
            },

            /**
             * Set project `projectId`'s manager policy (#758; PRJ-14): who may send it requests and what its manager may
             * do without asking (`checkedPmPolicy` — a priority cap above normal is refused). The manager agent is kept.
             * 404 for an unknown project, 400 for a bad policy.
             */
            async setProjectPmPolicy(projectId: ProjectId, policy: PmPolicy): Promise<ProjectRecord> {
                const project = (ctx.state.projects ?? []).find((p) => p.id === projectId);
                if (!project) throw new ServerFnError(404, `Workspace.setProjectPmPolicy: no project ${String(projectId)} in this workspace`);
                const checked = pmChecked('setProjectPmPolicy', () => checkedPmPolicy(policy));
                const record: ProjectRecord = { ...project, pm: { ...(project.pm?.agentId ? { agentId: project.pm.agentId } : {}), policy: checked }, updatedAt: now() };
                ctx.state.projects = (ctx.state.projects ?? []).map((p) => (p.id === projectId ? record : p));
                await ctx.save();
                const at = record.updatedAt;
                const data: ProjectChangedData = { projectId, name: record.name, op: 'updated', changed: ['pm.policy'] };
                await recordAudit(ctx, ownerOfWorkspaceKey(ctx.key) as WorkspaceId, {
                    key: `${ctx.key}:project:${projectId}:pm-policy:${at}`,
                    kind: 'project.changed',
                    at,
                    by: `user:${ctx.state.owner}`,
                    summary: `project ${record.name} (${projectId}) manager policy set`,
                    data
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
                // The preset (#480) is held to the platform's rule now; the daemon has the last word once it exists (the OS is unknown here).
                const allowedRoots = input.allowedRoots === undefined ? undefined : checkPolicyRoots({ allowedRoots: input.allowedRoots }, undefined);
                const pairing = { code: createPairingCode(), expiresAt: at + PAIRING_CODE_TTL_MS, ...(allowedRoots && allowedRoots.length > 0 ? { allowedRoots } : {}) };
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
            async claimPairing(code: string): Promise<{ machineId: MachineId; allowedRoots?: readonly string[] } | null> {
                const at = now();
                const i = ctx.state.machines.findIndex((m) => m.pairing !== undefined && codesMatch(m.pairing.code, code));
                if (i < 0) return null;
                const entry = ctx.state.machines[i]!;
                if (entry.pairing!.expiresAt <= at) {
                    ctx.state.machines.splice(i, 1);
                    await ctx.save();
                    return null;
                }
                const allowedRoots = entry.pairing!.allowedRoots;
                ctx.state.machines[i] = { id: entry.id, name: entry.name, status: 'paired', registeredAt: entry.registeredAt, pairedAt: at };
                await ctx.save();
                return { machineId: entry.id, ...(allowedRoots ? { allowedRoots } : {}) };
            },

            /** Every machine, without the pairing codes — those were shown once, at registration. */
            async listMachines(): Promise<readonly MachineIndexEntry[]> {
                return ctx.state.machines.map((m) => {
                    const { pairing: _pairing, ...rest } = ctx.snapshot(m);
                    return rest;
                });
            },

            /**
             * Revokes the machine and drops the index entry; clears `lastMachineId` when it was this one
             * (chats keep the dangling id, as with a removed project).
             *
             * Revoked FIRST, over a hop, for a machine the index calls paired (#259, USR-04): dropping the row
             * alone leaves `tokenHash` valid, so a daemon still holding the token could keep reporting, hosting
             * sessions and answering `env.request` for a machine its owner removed. Revoking is idempotent, so
             * an already-revoked machine is removed all the same; a machine that never paired has no token and
             * skips the hop. `Machine.revoke` is elevated (#355), which makes removing a paired machine elevated
             * too — and a refusal leaves the row in place rather than orphaning a live token.
             */
            async removeMachine(machineId: MachineId): Promise<boolean> {
                const i = ctx.state.machines.findIndex((m) => m.id === machineId);
                if (i < 0) return false;
                if (ctx.state.machines[i]!.status === 'paired') {
                    const workspaceId = ownerOfWorkspaceKey(ctx.key) as WorkspaceId;
                    await (ctx.actor(machineRefDef(), machineKey(workspaceId, machineId)) as unknown as MachineRevokeClient).revoke();
                }
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
                // Only a patch that names a field sets them: an empty `updates: {}` keeps the workspace on the defaults.
                if (patch.updates && (patch.updates.defaultChannel !== undefined || patch.updates.defaultPolicy !== undefined)) {
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
export { checkedPmPolicy, pmPolicyOf, PM_SENDER_RULES_MAX, PM_SENDERS_PER_RULE_MAX } from './pm-policy.js';
