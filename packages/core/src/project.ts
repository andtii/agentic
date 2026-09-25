/**
 * Projects (#329, contract #330): a named piece of work that says where it
 * lives on each machine, who works on it by default, which connectors every
 * session in it gets, and which project feature plugins are switched on.
 * Projects are few and small, so they live inline on the Workspace record;
 * a chat, a task and a schedule carry a `ProjectId`, never a copy of the
 * folders — the router resolves the folder for the environment it placed
 * the work on, so the same project runs at `C:\Dev\agentic\main` on one
 * machine and `/Users/me/dev/agentic` on another.
 */

import type { ConnectorRef } from './agent.js';
import type { AgentId, ChatId, EnvironmentId, MachineId, ProjectId, TaskId } from './ids.js';
import type { ConfigSchema } from './plugin-config.js';
import type { PluginManifest } from './plugin.js';
import type { FsError, FsGitInfo, FsOp, FsResult } from './workdir.js';

/** A workspace holds at most this many projects. */
export const PROJECTS_MAX = 50;

/** The `kind` a project feature plugin's manifest declares. */
export const PROJECT_FEATURE_KIND = 'project-feature';

/** Who a chat in the project starts with: the New chat picker preselects them; it is a default, not a fence. */
export interface ProjectMembers {
    readonly agentIds: readonly AgentId[];
    /** One of `agentIds`, or none. */
    readonly coordinator: AgentId | null;
}

/** Settings of the enabled project feature plugins, by plugin id; an entry's presence is what enables the plugin. */
export type ProjectFeatures = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

export interface ProjectRecord {
    readonly id: ProjectId;
    readonly name: string;
    readonly description?: string;
    readonly members: ProjectMembers;
    /**
     * Where the project lives, by `ProjectFolderKey` (#702): `<machineId>/*` is the folder on a machine, for every
     * environment on it whose `cwdRoots` hold it; `<machineId>/<environmentId>` overrides it for one environment.
     * Each absolute and machine-native. A bare environment id is the shape before #702 (environment ids are only
     * unique per machine), still read as the last fallback and never written.
     */
    readonly folders: Readonly<Partial<Record<string, string>>>;
    /** Connectors every session in the project gets, on top of the agent's own. */
    readonly connectors: readonly ConnectorRef[];
    readonly features: ProjectFeatures;
    readonly createdAt: number;
    readonly updatedAt: number;
}

/**
 * What `Workspace.upsertProject` takes: without `id` a new project (`name`
 * required), with one a change. A `null` folder or feature removes that entry;
 * `null` clears the description. Fields left out are kept.
 */
export interface ProjectPatch {
    readonly id?: ProjectId;
    readonly name?: string;
    readonly description?: string | null;
    readonly members?: ProjectMembers;
    readonly folders?: Readonly<Partial<Record<string, string | null>>>;
    readonly connectors?: readonly ConnectorRef[];
    readonly features?: Readonly<Record<string, Readonly<Record<string, unknown>> | null>>;
}

/**
 * A project feature plugin's manifest. `config` stays the plugin's workspace-wide
 * settings like every other kind (usually empty); `projectSettings` is the schema
 * of the per-project settings a project stores under `features[id]` — the same
 * typed subset the settings form renders and `validateConfig` checks.
 */
export interface ProjectFeatureManifest extends PluginManifest {
    readonly kind: typeof PROJECT_FEATURE_KIND;
    readonly projectSettings: ConfigSchema;
}

export function isProjectFeatureManifest(manifest: PluginManifest): manifest is ProjectFeatureManifest {
    if (manifest.kind !== PROJECT_FEATURE_KIND || !Object.hasOwn(manifest, 'projectSettings')) return false;
    const schema = (manifest as { projectSettings?: unknown }).projectSettings;
    return typeof schema === 'object' && schema !== null && !Array.isArray(schema);
}

/** A folder as the daemon lists it: the path and, for a repo or worktree, its git badge. */
export interface ProjectFolderInfo {
    readonly path: string;
    readonly git?: FsGitInfo;
}

/** The project and this plugin's settings in it (defaults already filled in by the caller). */
export interface ProjectFeatureContext {
    readonly project: ProjectRecord;
    readonly settings: Readonly<Record<string, unknown>>;
}

/** An `fs.request` round trip to the environment's daemon, answered like the wire does: a result or the daemon's error. */
export type ProjectFeatureFs = (op: FsOp) => Promise<{ readonly result: FsResult; readonly error?: undefined } | { readonly result?: undefined; readonly error: FsError }>;

export interface ProjectFeatureSessionInput extends ProjectFeatureContext {
    readonly taskId: TaskId;
    /** The chat the task came from, when it did. */
    readonly chatId?: ChatId;
    readonly environmentId: EnvironmentId;
    /** The folder the router resolved for this session (the project's for the environment unless overridden). */
    readonly cwd: string;
    readonly fs: ProjectFeatureFs;
}

/**
 * Why a chat no longer works in a project (#623): it was moved to another project or out of any (`project-changed`),
 * or deleted (`deleted`, once chats can be).
 */
export type ProjectFeatureReleaseReason = 'project-changed' | 'deleted';

/**
 * A chat left the project (#623), for one environment the project has a folder on: `cwd` is that folder, `fs` its
 * daemon. What a plugin tidies up is its own business; the platform runs it best effort, after the fact.
 */
export interface ProjectFeatureChatReleaseInput extends ProjectFeatureContext {
    readonly chatId: ChatId;
    readonly reason: ProjectFeatureReleaseReason;
    readonly environmentId: EnvironmentId;
    readonly cwd: string;
    readonly fs: ProjectFeatureFs;
}

/** What `beforeSession` may change: the folder the session opens in, and text appended to its system prompt. */
export interface ProjectFeatureSessionEffect {
    readonly cwd?: string;
    readonly instructions?: string;
}

/**
 * A named starting point for a project's settings (#621): picking it fills the fields it names, and every field stays
 * editable afterwards — a preset is a shortcut, never a mode the platform special-cases. A field set to `null` is
 * cleared (back to the schema's default), so a preset can undo another's template.
 */
export interface ProjectFeaturePreset {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
    readonly settings: Readonly<Record<string, unknown>>;
}

/** What a feature's settings would do for one folder (#621): the sample it is shown for, then labelled values. */
export interface ProjectFeaturePreviewInput {
    readonly project: Pick<ProjectRecord, 'name'>;
    readonly settings: Readonly<Record<string, unknown>>;
    /** A folder of the project, when it has one — the preview is for it. */
    readonly folder?: ProjectFolderInfo;
}

export interface ProjectFeaturePreviewLine {
    readonly label: string;
    readonly value: string;
}

/**
 * The code half of a project feature plugin, beside its manifest in the
 * catalogue like every other kind. Everything is optional, and it all runs on
 * the platform: a plugin composes the daemon's generic folder operations and
 * never ships daemon code.
 * - `detect`: whether a folder looks like this feature's (git: it has a git badge);
 *   the project form suggests the feature when a folder is added.
 * - `beforeSession`: run by the router once per task after the folder is resolved
 *   and before the session opens. A thrown error parks the task with its message
 *   (EXE-12: never a silent fallback).
 * - `instructions`: a fragment merged into every session's system prompt.
 * - `onChatReleased` (#623): a chat left the project, once per environment the project has a folder on whose
 *   machine is online. Best effort: it never blocks the move, a throw is audited with its message, and the text it
 *   returns (what it did, if anything) goes on the audit record.
 * - `presets`, `settingsErrors`, `previewSettings` (#621): what the settings form offers beside the schema — named
 *   starting points, the problems a schema cannot express (a template's unknown token) by settings key, and what the
 *   settings would do for a folder of the project. Pure: the form runs them on every edit.
 */
export interface ProjectFeaturePlugin {
    readonly manifest: ProjectFeatureManifest;
    detect?(folder: ProjectFolderInfo): boolean;
    beforeSession?(input: ProjectFeatureSessionInput): Promise<ProjectFeatureSessionEffect | undefined>;
    instructions?(ctx: ProjectFeatureContext): string | undefined;
    readonly presets?: readonly ProjectFeaturePreset[];
    settingsErrors?(settings: Readonly<Record<string, unknown>>): Readonly<Record<string, string>>;
    previewSettings?(input: ProjectFeaturePreviewInput): readonly ProjectFeaturePreviewLine[];
    onChatReleased?(input: ProjectFeatureChatReleaseInput): Promise<string | undefined>;
}

/** `settings` with a preset's fields laid over them (#621): a `null` field cleared, an `undefined` one ignored, every other field kept as it was. */
export function applyProjectFeaturePreset(settings: Readonly<Record<string, unknown>>, preset: ProjectFeaturePreset): Record<string, unknown> {
    const next: Record<string, unknown> = { ...settings };
    for (const [key, value] of Object.entries(preset.settings)) {
        if (value === null) delete next[key];
        else if (value !== undefined) next[key] = value;
    }
    return next;
}

/** The `ProjectRecord.folders` key of a machine's folder (`<machineId>/*`), or of an override for one environment on it. */
export function projectFolderKey(machineId: MachineId, environmentId?: EnvironmentId): string {
    return `${machineId}/${environmentId ?? '*'}`;
}

/**
 * A `ProjectRecord.folders` key read back: a machine's folder (no `environmentId`), an override (both), or a
 * pre-#702 bare environment id (`legacy`, no `machineId`). `null` for a key of none of these shapes.
 */
export function parseProjectFolderKey(key: string): { readonly machineId?: MachineId; readonly environmentId?: EnvironmentId; readonly legacy?: true } | null {
    const at = key.indexOf('/');
    if (at < 0) return key.trim() ? { environmentId: key as EnvironmentId, legacy: true } : null;
    const machineId = key.slice(0, at);
    const rest = key.slice(at + 1);
    if (!machineId.trim() || !rest.trim() || rest.includes('/')) return null;
    return rest === '*' ? { machineId: machineId as MachineId } : { machineId: machineId as MachineId, environmentId: rest as EnvironmentId };
}

/**
 * The project's folder for `environmentId` on `machineId`, or `undefined` when it has none there: the override for
 * that environment, else the machine's folder, else a pre-#702 folder keyed by the bare environment id. Without a
 * machine only the last applies. The caller checks the machine's folder against the environment's roots.
 */
export function projectFolderFor(project: Pick<ProjectRecord, 'folders'>, environmentId: EnvironmentId, machineId?: MachineId): string | undefined {
    const at = (key: string): string | undefined => (Object.hasOwn(project.folders, key) ? project.folders[key] : undefined);
    return (machineId !== undefined ? (at(projectFolderKey(machineId, environmentId)) ?? at(projectFolderKey(machineId))) : undefined) ?? at(environmentId);
}

/** Whether `projectFolderFor` would answer from the machine's shared folder (`<machineId>/*`) rather than an override or a pre-#702 entry. */
export function projectFolderIsShared(project: Pick<ProjectRecord, 'folders'>, environmentId: EnvironmentId, machineId: MachineId): boolean {
    return !Object.hasOwn(project.folders, projectFolderKey(machineId, environmentId)) && Object.hasOwn(project.folders, projectFolderKey(machineId));
}

/** The ids of the feature plugins the project has switched on. */
export function enabledProjectFeatures(project: Pick<ProjectRecord, 'features'>): readonly string[] {
    return Object.keys(project.features);
}
