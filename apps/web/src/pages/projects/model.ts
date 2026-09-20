/**
 * The project form's view model (#333, architecture §10): a draft the form
 * edits ↔ the `ProjectPatch` `Workspace.upsertProject` takes, the folder
 * rows (one per daemon environment, each with the git badge the picker or
 * `locate` handed back), the feature suggestions a folder's badge makes
 * (`ProjectFeaturePlugin.detect`), and the effective folder a chat member
 * runs in (its own override, else the project's for its environment). Pure:
 * the mock page and the live page render the same form over it.
 */
import { isProjectFeatureManifest, projectFolderFor, sameOrigin, type ConfigSchema, type EnvironmentId, type FsGitInfo, type PluginManifest, type ProjectFeatureManifest, type ProjectFeaturePlugin, type ProjectFolderInfo, type ProjectPatch, type ProjectRecord, type WorkdirRef } from '@agentic/core';

/** A folder row's value: the path and, when the listing or `locate` showed one, its git badge. */
export interface ProjectFolderDraft {
    readonly path: string;
    readonly git?: FsGitInfo;
}

export interface ProjectDraft {
    name: string;
    description: string;
    /** The roster, in pick order; `coordinator` is one of them or `''`. */
    picked: string[];
    coordinator: string;
    /** Connector plugin ids. */
    connectors: string[];
    /** By environment id; an environment with no row entry has no folder. */
    folders: Record<string, ProjectFolderDraft>;
    /** The enabled feature plugins with their settings; presence is what enables one. */
    features: Record<string, Record<string, unknown>>;
}

export type ProjectErrors = Partial<Record<'name', string>>;

/** A blank draft, or one opened on a stored project (a stored folder has no badge until it is picked again). */
export function projectDraftOf(project?: ProjectRecord): ProjectDraft {
    return {
        name: project?.name ?? '',
        description: project?.description ?? '',
        picked: [...(project?.members.agentIds ?? [])],
        coordinator: project?.members.coordinator ?? '',
        connectors: (project?.connectors ?? []).map((c) => c.id),
        folders: Object.fromEntries(Object.entries(project?.folders ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string').map(([id, path]) => [id, { path }])),
        features: Object.fromEntries(Object.entries(project?.features ?? {}).map(([id, settings]) => [id, { ...settings }]))
    };
}

/**
 * `/projects/new?name=&env=&path=&origin=` (#336, "Create project from this folder"): what the form opens on — the
 * name, and one folder row with the origin as its badge, so Find on the other rows and `detect` work at once.
 * `undefined` without a usable query; a name alone is just the name.
 */
export function projectPrefillOf(query: Readonly<Record<string, string | readonly string[] | undefined>>): Partial<ProjectDraft> | undefined {
    const one = (value: string | readonly string[] | undefined): string | undefined => {
        const text = Array.isArray(value) ? value[0] : value;
        return typeof text === 'string' && text.trim() ? text : undefined;
    };
    const name = one(query['name']);
    const env = one(query['env']);
    const path = one(query['path']);
    const origin = one(query['origin']);
    if (!env || !path) return name ? { name } : undefined;
    return { ...(name ? { name } : {}), folders: { [env]: { path, ...(origin ? { git: { kind: 'repo', origin } } : {}) } } };
}

export function validateProjectDraft(draft: Pick<ProjectDraft, 'name'>): ProjectErrors {
    return draft.name.trim() ? {} : { name: 'A name is required.' };
}

/**
 * The patch for `upsertProject`: every section is sent whole (the actor keeps what a patch leaves out, but the
 * form shows everything), a folder or feature the draft dropped from `base` is sent as `null`, and a description
 * cleared on an edit as `null`.
 */
export function projectPatchOf(draft: ProjectDraft, base?: Pick<ProjectRecord, 'id' | 'description' | 'folders' | 'features'>): ProjectPatch {
    const description = draft.description.trim();
    const folders: Record<string, string | null> = {};
    for (const [id, row] of Object.entries(draft.folders)) if (row.path.trim()) folders[id] = row.path.trim();
    for (const id of Object.keys(base?.folders ?? {})) if (!(id in folders)) folders[id] = null;
    const features: Record<string, Record<string, unknown> | null> = {};
    for (const [id, settings] of Object.entries(draft.features)) features[id] = { ...settings };
    for (const id of Object.keys(base?.features ?? {})) if (!(id in features)) features[id] = null;
    const picked = [...new Set(draft.picked)];
    return {
        ...(base ? { id: base.id } : {}),
        name: draft.name.trim(),
        ...(description ? { description } : base?.description ? { description: null } : {}),
        members: { agentIds: picked as never[], coordinator: (picked.includes(draft.coordinator) ? draft.coordinator : null) as never },
        folders,
        connectors: [...new Set(draft.connectors)].map((id) => ({ id })),
        features
    };
}

/** The enabled project feature manifests among the Registry's plugins, in the Registry's order. */
export function featureManifestsOf(plugins: readonly { readonly manifest: PluginManifest; readonly enabled: boolean }[]): ProjectFeatureManifest[] {
    return plugins.filter((p) => p.enabled).map((p) => p.manifest).filter(isProjectFeatureManifest);
}

/** The enabled connector plugins as chip options. */
export function connectorOptionsOf(plugins: readonly { readonly manifest: PluginManifest; readonly enabled: boolean }[]): { readonly value: string; readonly label: string }[] {
    return plugins.filter((p) => p.enabled && p.manifest.kind === 'connector').map((p) => ({ value: p.manifest.id, label: p.manifest.name }));
}

/** The repo the project is: the first folder row whose badge carries an origin. */
export function originOf(folders: Readonly<Record<string, ProjectFolderDraft>>, except?: string): string | undefined {
    for (const [id, row] of Object.entries(folders)) if (id !== except && row.git?.origin) return row.git.origin;
    return undefined;
}

/** Whether this row's checkout is of another repo than the rest: a warning, not a block (a project may span two). */
export function originMismatch(folders: Readonly<Record<string, ProjectFolderDraft>>, environmentId: string): boolean {
    const mine = folders[environmentId]?.git?.origin;
    const others = originOf(folders, environmentId);
    return !!mine && !!others && !sameOrigin(mine, others);
}

/** The feature plugins whose `detect` says a folder is theirs. */
export function detectedFeatures(catalogue: Readonly<Record<string, ProjectFeaturePlugin>>, folder: ProjectFolderInfo): string[] {
    return Object.entries(catalogue).filter(([, plugin]) => plugin.detect?.(folder) === true).map(([id]) => id);
}

/** `settings` with `origin` filled from the folders when the schema has that property and it is still empty (the git feature, #335). */
export function withOrigin(schema: ConfigSchema, settings: Readonly<Record<string, unknown>>, origin: string | undefined): Record<string, unknown> {
    if (!origin || !schema.properties?.['origin'] || (typeof settings['origin'] === 'string' && settings['origin'])) return { ...settings };
    return { ...settings, origin };
}

/** The environments a project has a folder on, with the label the pickers use — the list's badges. */
export function projectEnvironments(project: Pick<ProjectRecord, 'folders'>, environments: readonly { readonly id: string; readonly label: string }[]): { readonly id: string; readonly label: string; readonly path: string }[] {
    return Object.entries(project.folders)
        .filter((e): e is [string, string] => typeof e[1] === 'string')
        .map(([id, path]) => ({ id, label: environments.find((e) => e.id === id)?.label ?? id, path }));
}

/**
 * The folder a chat member runs in: its own override for the chat (`Chat.setWorkdir`), else the project's folder
 * for the environment it runs in, else none — what the context panel shows and marks "from project".
 */
export function effectiveWorkdir(member: { readonly workdir?: WorkdirRef }, environmentId: string | undefined, project: Pick<ProjectRecord, 'folders'> | undefined): { readonly ref: WorkdirRef | null; readonly inherited: boolean } {
    if (member.workdir) return { ref: member.workdir, inherited: false };
    const path = project && environmentId ? projectFolderFor(project, environmentId as EnvironmentId) : undefined;
    return path ? { ref: { environmentId: environmentId as EnvironmentId, path }, inherited: true } : { ref: null, inherited: false };
}
