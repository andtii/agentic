/**
 * The project form's view model (#333, architecture §10): a draft the form
 * edits ↔ the `ProjectPatch` `Workspace.upsertProject` takes, the folder
 * rows (one per machine and an override per environment on it, #702, each
 * with the git badge the picker or `locate` handed back), the feature suggestions a folder's badge makes
 * (`ProjectFeaturePlugin.detect`), and the effective folder a chat member
 * runs in (its own override, else the project's for its environment). Pure:
 * the mock page and the live page render the same form over it.
 */
import { isProjectFeatureManifest, parseProjectFolderKey, pathWithin, projectFolderFor, projectFolderIsShared, projectFolderKey, sameOrigin, type ConfigSchema, type EnvironmentId, type FsGitInfo, type MachineId, type PluginManifest, type ProjectFeatureManifest, type ProjectFeaturePlugin, type ProjectFolderInfo, type ProjectPatch, type ProjectRecord, type WorkdirRef } from '@agentic/core';
import type { WorkdirEnvironment } from '@agentic/ui';
import type { MachineEntry } from '../ops/environments';

/** A folder row's value: the path and, when the listing or `locate` showed one, its git badge. */
export interface ProjectFolderDraft {
    readonly path: string;
    readonly git?: FsGitInfo;
}

/** A paired machine as the form groups the folder rows (#702): environment ids are only unique per machine. */
export interface ProjectMachine {
    readonly id: string;
    readonly name: string;
    readonly environments: readonly WorkdirEnvironment[];
}

export interface ProjectDraft {
    name: string;
    description: string;
    /** The roster, in pick order; `coordinator` is one of them or `''`. */
    picked: string[];
    coordinator: string;
    /** Connector plugin ids. */
    connectors: string[];
    /** By `projectFolderKey`: `<machineId>/*` the machine's folder, `<machineId>/<environmentId>` an override; no entry, no folder. */
    folders: Record<string, ProjectFolderDraft>;
    /** The enabled feature plugins with their settings; presence is what enables one. */
    features: Record<string, Record<string, unknown>>;
}

export type ProjectErrors = Partial<Record<'name', string>>;

/** Whether `path` is inside `env`'s working roots — where a machine's folder reaches that environment. */
export const reaches = (env: Pick<WorkdirEnvironment, 'roots' | 'os'>, path: string): boolean => pathWithin(path, env.roots, env.os);

/** Whether the draft still holds a folder keyed by a bare environment id (a pre-#702 project, or a prefill): `resolveFolders` places it. */
export const hasUnplacedFolders = (folders: Readonly<Record<string, ProjectFolderDraft>>): boolean => Object.keys(folders).some((key) => parseProjectFolderKey(key)?.legacy === true);

/**
 * The draft's folders with every one keyed by a bare environment id placed on a machine (#702): on each machine whose
 * environment of that id has it inside its roots (or the only machine reporting that id), as an override there — and
 * a machine whose overrides so made all name one folder takes it as its folder instead. Keys by machine are kept; one
 * no machine can take is left out, so the save removes it. With no machine known yet, nothing changes.
 */
export function resolveFolders(folders: Readonly<Record<string, ProjectFolderDraft>>, machines: readonly ProjectMachine[]): Record<string, ProjectFolderDraft> {
    if (!machines.length || !hasUnplacedFolders(folders)) return { ...folders };
    const out: Record<string, ProjectFolderDraft> = {};
    const moved = new Map<string, Record<string, ProjectFolderDraft>>();
    for (const [key, row] of Object.entries(folders)) {
        const parsed = parseProjectFolderKey(key);
        if (!parsed) continue;
        if (!parsed.legacy) {
            out[key] = row;
            continue;
        }
        // The machines reporting that id whose roots hold the folder; when none does but one machine reports it, that
        // one — the save then says why the folder cannot be used, rather than the form losing it.
        const reporting = machines.filter((m) => m.environments.some((e) => e.id === parsed.environmentId));
        const holding = reporting.filter((m) => reaches(m.environments.find((e) => e.id === parsed.environmentId)!, row.path));
        for (const m of holding.length ? holding : reporting.length === 1 ? reporting : []) moved.set(m.id, { ...moved.get(m.id), [parsed.environmentId!]: row });
    }
    for (const [machineId, byEnv] of moved) {
        const shared = projectFolderKey(machineId as MachineId);
        const rows = Object.values(byEnv);
        if (new Set(rows.map((r) => r.path)).size === 1 && !out[shared]) out[shared] = rows[0]!;
        else for (const [environmentId, row] of Object.entries(byEnv)) out[projectFolderKey(machineId as MachineId, environmentId as EnvironmentId)] ??= row;
    }
    return out;
}

/** A blank draft, or one opened on a stored project (a stored folder has no badge until it is picked again). */
export function projectDraftOf(project?: ProjectRecord): ProjectDraft {
    return {
        name: project?.name ?? '',
        description: project?.description ?? '',
        picked: [...(project?.members.agentIds ?? [])],
        coordinator: project?.members.coordinator ?? '',
        connectors: (project?.connectors ?? []).map((c) => c.id),
        folders: Object.fromEntries(Object.entries(project?.folders ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string').map(([key, path]) => [key, { path }])),
        features: Object.fromEntries(Object.entries(project?.features ?? {}).map(([id, settings]) => [id, { ...settings }]))
    };
}

/**
 * `/projects/new?name=&env=&path=&origin=` (#336, "Create project from this folder"): what the form opens on — the
 * name, and the folder with the origin as its badge, so Find on the other rows and `detect` work at once. The
 * folder is keyed by `env` until `resolveFolders` places it on the machine whose roots hold it (#702).
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
    // A folder not yet placed on a machine (#702) is never sent: the Workspace refuses a bare environment id.
    for (const [key, row] of Object.entries(draft.folders)) if (row.path.trim() && !parseProjectFolderKey(key)?.legacy) folders[key] = row.path.trim();
    for (const key of Object.keys(base?.folders ?? {})) if (!(key in folders) && !(key in draft.folders)) folders[key] = null;
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
export function originMismatch(folders: Readonly<Record<string, ProjectFolderDraft>>, key: string): boolean {
    const mine = folders[key]?.git?.origin;
    const others = originOf(folders, key);
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

/** Where a project has folders, labelled for the list's badges (#702): the machine's name, or its environment's label for an override. */
export function projectPlaces(project: Pick<ProjectRecord, 'folders'>, machines: readonly ProjectMachine[]): { readonly key: string; readonly label: string; readonly path: string }[] {
    const out: { key: string; label: string; path: string }[] = [];
    for (const [key, path] of Object.entries(project.folders)) {
        const parsed = typeof path === 'string' ? parseProjectFolderKey(key) : null;
        if (!parsed) continue;
        // A pre-#702 key names only an environment: the machine whose environment of that id holds the folder, else the first reporting it.
        const reporting = (m: ProjectMachine) => m.environments.find((e) => e.id === parsed.environmentId);
        const machine = parsed.machineId !== undefined ? machines.find((m) => m.id === parsed.machineId) : (machines.find((m) => { const e = reporting(m); return !!e && reaches(e, path!); }) ?? machines.find((m) => !!reporting(m)));
        const env = parsed.environmentId !== undefined ? machine?.environments.find((e) => e.id === parsed.environmentId) : undefined;
        const label = parsed.environmentId !== undefined ? (env?.label ?? parsed.environmentId) : (machine?.name ?? parsed.machineId!);
        out.push({ key, label, path: path! });
    }
    return out;
}

/** An environment's roots on one machine, as the directory reports them (#702: its id alone may name another machine's). */
export function rootsOn(machines: readonly MachineEntry[] | undefined, machineId: string | undefined, environmentId: string): Pick<WorkdirEnvironment, 'roots' | 'os'> | undefined {
    const m = machineId !== undefined ? machines?.find((x) => x.id === machineId) : undefined;
    const env = m?.environments.find((e) => e.id === environmentId);
    return m && env ? { roots: env.cwdRoots, os: m.os ?? 'windows' } : undefined;
}

/**
 * The project's folder for `environmentId` on `machineId`, as the router takes it (#702): an override or a pre-#702
 * entry as stored; the machine's folder only when `env`'s roots hold it — unknown roots take it as stored.
 */
export function projectFolderOn(project: Pick<ProjectRecord, 'folders'>, environmentId: string, machineId: string | undefined, env: Pick<WorkdirEnvironment, 'roots' | 'os'> | undefined): string | undefined {
    const path = projectFolderFor(project, environmentId as EnvironmentId, machineId as MachineId | undefined);
    if (path === undefined || machineId === undefined || !env || !projectFolderIsShared(project, environmentId as EnvironmentId, machineId as MachineId)) return path;
    return reaches(env, path) ? path : undefined;
}

/**
 * The folder a chat member runs in: its own override for the chat (`Chat.setWorkdir`), else the project's folder
 * for the environment it runs in on the chat's machine (#702, `projectFolderOn` with that environment's roots
 * there), else none — what the context panel shows and marks "from project".
 */
export function effectiveWorkdir(member: { readonly workdir?: WorkdirRef }, environmentId: string | undefined, project: Pick<ProjectRecord, 'folders'> | undefined, machineId?: string, env?: Pick<WorkdirEnvironment, 'roots' | 'os'>): { readonly ref: WorkdirRef | null; readonly inherited: boolean } {
    if (member.workdir) return { ref: member.workdir, inherited: false };
    const path = project && environmentId ? projectFolderOn(project, environmentId, machineId, env) : undefined;
    return path ? { ref: { environmentId: environmentId as EnvironmentId, path }, inherited: true } : { ref: null, inherited: false };
}
