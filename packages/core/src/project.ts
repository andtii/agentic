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
import type { AgentId, ChatId, EnvironmentId, ProjectId, TaskId } from './ids.js';
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
    /** One folder per environment, each absolute, machine-native and inside that environment's `cwdRoots`. */
    readonly folders: Readonly<Partial<Record<EnvironmentId, string>>>;
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
    readonly folders?: Readonly<Partial<Record<EnvironmentId, string | null>>>;
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

/** What `beforeSession` may change: the folder the session opens in, and text appended to its system prompt. */
export interface ProjectFeatureSessionEffect {
    readonly cwd?: string;
    readonly instructions?: string;
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
 */
export interface ProjectFeaturePlugin {
    readonly manifest: ProjectFeatureManifest;
    detect?(folder: ProjectFolderInfo): boolean;
    beforeSession?(input: ProjectFeatureSessionInput): Promise<ProjectFeatureSessionEffect | undefined>;
    instructions?(ctx: ProjectFeatureContext): string | undefined;
}

/** The project's folder on `environmentId`, or `undefined` when it has none there. */
export function projectFolderFor(project: Pick<ProjectRecord, 'folders'>, environmentId: EnvironmentId): string | undefined {
    return Object.hasOwn(project.folders, environmentId) ? project.folders[environmentId] : undefined;
}

/** The ids of the feature plugins the project has switched on. */
export function enabledProjectFeatures(project: Pick<ProjectRecord, 'features'>): readonly string[] {
    return Object.keys(project.features);
}
