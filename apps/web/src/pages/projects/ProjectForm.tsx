/**
 * The project form (#333): name and description, the roster on the New
 * chat member cards with the coordinator radio, the connectors as chips,
 * one folder row per machine — every environment on it whose roots hold
 * the folder runs there — with an override per environment on demand
 * (#702; Browse through the picker scoped to the machine's environments;
 * Find through `locate` once another row's badge says which repo this is), and the feature plugins as switches whose
 * settings render from the manifest's `projectSettings` schema. A folder's
 * git badge stays on its row; a plugin's `detect` suggests the feature;
 * a row whose checkout is of another repo warns and never blocks.
 */
import { component, signal, watch, type Define } from 'sigx';
import { applyProjectFeaturePreset, configDefaults, parseProjectFolderKey, projectFolderKey, type EnvironmentId, type FsGitInfo, type MachineId, type ProjectFeatureManifest, type ProjectFeaturePlugin, type ProjectFeaturePreset, type ProjectPatch, type ProjectRecord } from '@agentic/core';
import { derivedModel } from '@sigx/zero/behaviors';
import { RadioGroup } from '@sigx/zero';
import { Field } from '@sigx/zero-daisyui/components';
import { Button, ChipInput, ConfirmDialog, ErrorNote, FormDialog, Label, SchemaForm, Switch, Tag, TextField, TextareaField, gitBadgeText, type SchemaFormApi, type WorkdirEnvironment, type WorkdirSelection } from '@agentic/ui';
import { projectFeatureCatalogue } from '../../plugins/features';
import { MemberPicker } from '../chat/MemberPicker';
import type { AgentIdentity } from '../chat/live';
import { WorkdirInput } from '../workdir/WorkdirInput';
import type { LocateBackend } from './locate';
import { detectedFeatures, hasUnplacedFolders, originMismatch, originOf, projectDraftOf, projectPatchOf, reaches, resolveFolders, validateProjectDraft, withOrigin, type ProjectDraft, type ProjectErrors, type ProjectFolderDraft, type ProjectMachine } from './model';

export type ProjectFormProps =
    /** The project being edited; absent on the New project page. */
    & Define.Prop<'project', ProjectRecord>
    /** What a new project opens on (#336, `projectPrefillOf`): a name and a folder row with its badge, as if picked. */
    & Define.Prop<'initial', Partial<ProjectDraft>>
    & Define.Prop<'agents', readonly AgentIdentity[], true>
    /** Every daemon environment: the quota badges on the member cards. */
    & Define.Prop<'environments', readonly WorkdirEnvironment[], true>
    /** Every paired machine with its environments: one folder row each, an override row per environment (#702). */
    & Define.Prop<'machines', readonly ProjectMachine[], true>
    & Define.Prop<'connectors', readonly { readonly value: string; readonly label: string }[]>
    /** The enabled project feature manifests: one switch each, settings from `projectSettings`. */
    & Define.Prop<'features', readonly ProjectFeatureManifest[]>
    /** The feature plugins' code half, for `detect`; the build's catalogue by default. */
    & Define.Prop<'catalogue', Readonly<Record<string, ProjectFeaturePlugin>>>
    & Define.Prop<'locate', LocateBackend, true>
    & Define.Prop<'busy', boolean>
    /** What the save answered when it refused (a 400 from `upsertProject`). */
    & Define.Prop<'error', string>
    & Define.Event<'save', ProjectPatch>
    & Define.Event<'remove'>
    & Define.Event<'cancel'>;

export const ProjectForm = component<ProjectFormProps>(({ props, emit }) => {
    const onOf = (features: Readonly<Record<string, unknown>>): Record<string, boolean> => Object.fromEntries(Object.keys(features).map((id) => [id, true]));
    const st = signal<ProjectDraft & { attempted: boolean; finding: { key: string; machineId: string; environmentId: EnvironmentId; label: string } | null; overrides: Record<string, boolean>; match: string; detected: Record<string, string[]>; removing: boolean; featureError: string; on: Record<string, boolean>; live: Record<string, Record<string, unknown>> }>({
        ...projectDraftOf(props.project),
        ...(props.project ? {} : props.initial ?? {}),
        on: onOf(props.project?.features ?? {}),
        attempted: false,
        finding: null,
        overrides: {},
        match: '',
        detected: {},
        removing: false,
        featureError: '',
        live: {}
    });
    // The project landed after the form mounted (a live read): open on it, unless the person has started typing.
    watch(
        () => props.project?.id,
        () => {
            if (props.project && !st.name) Object.assign(st, projectDraftOf(props.project), { on: onOf(props.project.features) });
        }
    );
    // A folder keyed by a bare environment id — a pre-#702 project or a prefill — is placed on its machine once the machines are known.
    watch(
        () => [props.machines, st.folders] as const,
        () => {
            if (hasUnplacedFolders(st.folders) && props.machines.length) st.folders = resolveFolders(st.folders, props.machines);
        },
        { immediate: true }
    );
    const apis: Record<string, SchemaFormApi | null> = {};
    const catalogue = (): Readonly<Record<string, ProjectFeaturePlugin>> => props.catalogue ?? projectFeatureCatalogue;
    const features = (): readonly ProjectFeatureManifest[] => props.features ?? [];
    const origin = (): string | undefined => originOf(st.folders);
    const enabled = (id: string): boolean => Object.hasOwn(st.features, id);
    /** A feature's settings as the draft has them now (#621), under the schema's defaults — what the router would hand the plugin. */
    const settingsNow = (m: ProjectFeatureManifest): Readonly<Record<string, unknown>> => ({ ...configDefaults(m.projectSettings), ...(st.live[m.id] ?? st.features[m.id] ?? {}) });
    /** The plugin's own problems with the draft (#621), each labelled with its setting's title. */
    const pluginErrors = (m: ProjectFeatureManifest): string[] =>
        Object.entries(catalogue()[m.id]?.settingsErrors?.(settingsNow(m)) ?? {}).map(([key, message]) => `${m.projectSettings.properties?.[key.split('.')[0]!]?.title ?? key}: ${message}`);
    /** A preset laid over the draft as it is now; the form takes it as an edit, so every field stays the person's to change. */
    const applyPreset = (m: ProjectFeatureManifest, preset: ProjectFeaturePreset): void => {
        const api = apis[m.id];
        const next = applyProjectFeaturePreset(api?.value() ?? st.features[m.id] ?? {}, preset);
        if (api) api.load(next);
        else st.features = { ...st.features, [m.id]: next };
        st.live = { ...st.live, [m.id]: next };
    };
    /** A row's badge; a prefilled one (#336) carries the origin and no HEAD, so it is the kind alone, not "detached". */
    const badgeText = (git: FsGitInfo): string => (git.branch || git.head ? gitBadgeText(git) : git.kind);

    const prefillOrigins = (): void => {
        const o = origin();
        if (!o) return;
        for (const m of features()) if (enabled(m.id)) st.features = { ...st.features, [m.id]: withOrigin(m.projectSettings, st.features[m.id]!, o) };
    };
    const toggleFeature = (m: ProjectFeatureManifest, on: boolean): void => {
        const next = { ...st.features };
        if (on) next[m.id] = withOrigin(m.projectSettings, next[m.id] ?? {}, origin());
        else delete next[m.id];
        st.features = next;
        st.on = { ...st.on, [m.id]: on };
        st.featureError = '';
    };
    /** The features a folder's badge suggests, applied: a project with no feature yet takes the suggestion; one that has chosen keeps its choice. */
    const suggest = (key: string, row: ProjectFolderDraft): void => {
        const found = row.git ? detectedFeatures(catalogue(), { path: row.path, git: row.git }) : [];
        st.detected = { ...st.detected, [key]: found };
        if (found.length && !Object.keys(st.features).length) for (const id of found) { const m = features().find((f) => f.id === id); if (m) toggleFeature(m, true); }
    };
    /** A row's folder by `projectFolderKey`: the machine's (`<machineId>/*`) or one environment's override on it. */
    const setFolder = (key: string, pick: WorkdirSelection | null): void => {
        const next = { ...st.folders };
        if (pick) {
            next[key] = { path: pick.path, ...(pick.git ? { git: pick.git } : {}) };
            st.folders = next;
            suggest(key, next[key]!);
        } else {
            const detected = { ...st.detected };
            delete next[key];
            delete detected[key];
            st.folders = next;
            st.detected = detected;
        }
        prefillOrigins();
    };
    // A prefilled folder (#336) counts as picked: its badge suggests the features and its origin fills their settings.
    if (!props.project) {
        for (const [key, row] of Object.entries(st.folders)) suggest(key, row);
        prefillOrigins();
    }
    /** Find the repo for a row: under the roots of the environment it names, or for a machine's row its first browsable one. */
    const find = (key: string, machine: ProjectMachine, env: WorkdirEnvironment | undefined): void => {
        const o = origin();
        if (!o || !env) return;
        st.match = '';
        st.finding = { key, machineId: machine.id, environmentId: env.id, label: parseProjectFolderKey(key)?.environmentId ? env.label : machine.name };
        props.locate.start(env.id, o, machine.id);
    };
    const closeFind = (): void => {
        st.finding = null;
        props.locate.reset();
    };
    /** The match in effect: the picked one, else the first (the radios show it checked). */
    const matchInEffect = (): string => st.match || (props.locate.state.matches[0]?.path ?? '');
    const matchModel = derivedModel<string>(matchInEffect, (path) => { st.match = path; });
    /** Confirm: fill the row with the match — while there is none (still searching, an error, nothing found) the dialog stays, its results in view. */
    const useMatch = (): void => {
        const at = st.finding;
        const hit = props.locate.state.matches.find((m) => m.path === matchInEffect());
        if (!at || !hit) return;
        setFolder(at.key, { environmentId: at.environmentId, path: hit.path, git: hit.git });
        closeFind();
    };
    const save = (): void => {
        st.attempted = true;
        if (Object.keys(validateProjectDraft(st)).length) return;
        // Each enabled feature's settings form checks its own draft; a refused one keeps the page here with its fields marked.
        for (const m of features()) {
            if (!enabled(m.id)) continue;
            const api = apis[m.id];
            if ((api && !api.submit()) || pluginErrors(m).length) {
                st.featureError = `Check the ${m.name} settings.`;
                return;
            }
        }
        st.featureError = '';
        emit('save', projectPatchOf(st, props.project));
    };

    return () => {
        const errors: ProjectErrors = st.attempted ? validateProjectDraft(st) : {};
        const o = origin();
        const finding = st.finding;
        const found = props.locate.state;
        return (
            <div data-project-form data-editing={props.project ? '' : undefined}>
                <section data-project-section="identity" aria-label="Project">
                    <TextField model={() => st.name} name="project-name" label="Name" required error={errors.name} />
                    <TextareaField model={() => st.description} name="project-description" label="Description" rows={2} description="What the project is, for the people and agents in it." />
                </section>

                <section data-project-section="members" aria-label="Members">
                    <p data-project-hint>Who a chat in this project starts with. The New chat picker preselects them; they stay editable there.</p>
                    <MemberPicker
                        agents={props.agents}
                        environments={props.environments}
                        picked={st.picked}
                        coordinator={st.coordinator}
                        onToggle={(e) => {
                            st.picked = e.on ? [...new Set([...st.picked, e.id])] : st.picked.filter((p) => p !== e.id);
                            if (!e.on && st.coordinator === e.id) st.coordinator = '';
                        }}
                        onPickCoordinator={(id) => { st.coordinator = id; }}
                    />
                    {st.picked.length > 1 && st.coordinator ? (
                        <p data-project-hint>{props.agents.find((a) => a.id === st.coordinator)?.name ?? st.coordinator} coordinates. <button type="button" data-link-button onClick={() => { st.coordinator = ''; }}>No coordinator</button></p>
                    ) : null}
                </section>

                <section data-project-section="connectors" aria-label="Connectors">
                    <Label>Connectors</Label>
                    <p data-project-hint>Every session in the project gets these, on top of the agent's own.</p>
                    {props.connectors?.length
                        ? <ChipInput model={() => st.connectors} name="project-connectors" options={props.connectors} placeholder="Add a connector…" emptyText="None." />
                        : <p data-panel-note>No connector plugins are enabled. Add one under Plugins.</p>}
                </section>

                <section data-project-section="folders" aria-label="Folders">
                    <Label>Folders</Label>
                    <p data-project-hint>Where the project lives on each machine. Every environment on the machine runs there, unless it has its own folder here or a chat member is given another one in the chat.</p>
                    {props.machines.length ? (
                        <ul data-project-folders>
                            {props.machines.map((m) => {
                                const key = projectFolderKey(m.id as MachineId);
                                const row = st.folders[key];
                                const mismatch = originMismatch(st.folders, key);
                                const detected = st.detected[key] ?? [];
                                const browsable = m.environments.find((e) => !e.unavailable);
                                const at = row ? (m.environments.find((e) => reaches(e, row.path)) ?? m.environments[0]) : undefined;
                                const overridden = m.environments.filter((e) => st.folders[projectFolderKey(m.id as MachineId, e.id)]);
                                const open = !!st.overrides[m.id] || overridden.length > 0;
                                return (
                                    <li data-project-folder={m.id} data-mismatch={mismatch ? '' : undefined}>
                                        <WorkdirInput
                                            value={row && at ? { environmentId: at.id, path: row.path } : null}
                                            environments={m.environments}
                                            machineOf={() => m.id}
                                            {...(at ? { preferred: at.id } : {})}
                                            label={m.name}
                                            placeholder="No folder on this machine"
                                            name={`project-folder-${m.id}`}
                                            disabled={!!props.busy || !m.environments.length}
                                            onChange={(pick) => setFolder(key, pick)}
                                        />
                                        <span data-project-folder-meta>
                                            {row?.git ? <Tag>{badgeText(row.git)}</Tag> : null}
                                            {detected.map((id) => <Tag tone="live">{features().find((f) => f.id === id)?.name ?? id}</Tag>)}
                                            {!row && o ? <Button intent="default" icon="search" disabled={!!props.busy || !browsable} onClick={() => find(key, m, browsable)}>Find</Button> : null}
                                            {!row && o && !browsable && m.environments[0]?.unavailable ? <span data-project-folder-note>{m.environments[0].unavailable}</span> : null}
                                            {m.environments.length > 0 && !open ? <button type="button" data-link-button data-project-override-open onClick={() => { st.overrides = { ...st.overrides, [m.id]: true }; }}>Another folder for one environment…</button> : null}
                                        </span>
                                        {mismatch ? <p data-project-folder-warning role="status">This checkout has another origin ({row!.git!.origin}) than the rest of the project.</p> : null}
                                        {open ? (
                                            <ul data-project-overrides aria-label={`Environments on ${m.name}`}>
                                                {m.environments.map((env) => {
                                                    const okey = projectFolderKey(m.id as MachineId, env.id);
                                                    const own = st.folders[okey];
                                                    const inherits = !own && !!row && reaches(env, row.path);
                                                    return (
                                                        <li data-project-override={env.id} data-mismatch={originMismatch(st.folders, okey) ? '' : undefined}>
                                                            <WorkdirInput
                                                                value={own ? { environmentId: env.id, path: own.path } : null}
                                                                environments={[env]}
                                                                machineOf={() => m.id}
                                                                preferred={env.id}
                                                                label={env.label}
                                                                placeholder={inherits ? `The machine's folder (${row!.path})` : 'No folder in this environment'}
                                                                name={`project-folder-${m.id}-${env.id}`}
                                                                disabled={!!props.busy}
                                                                onChange={(pick) => setFolder(okey, pick)}
                                                            />
                                                            {!own && row && !inherits ? <span data-project-folder-note>The machine's folder is outside this environment's folders ({env.roots.join(', ') || 'none'}): it runs in its first folder unless you pick one here.</span> : null}
                                                            {!own && o && !env.unavailable ? <Button intent="default" icon="search" disabled={!!props.busy} onClick={() => find(okey, m, env)}>Find</Button> : null}
                                                        </li>
                                                    );
                                                })}
                                            </ul>
                                        ) : null}
                                    </li>
                                );
                            })}
                        </ul>
                    ) : <p data-panel-note>No machine is paired yet — a project without folders still names its members and connectors.</p>}
                </section>

                <section data-project-section="features" aria-label="Features">
                    <Label>Features</Label>
                    {features().length ? (
                        <ul data-project-features>
                            {features().map((m) => (
                                <li data-project-feature={m.id} data-on={enabled(m.id) ? '' : undefined}>
                                    <div data-project-feature-head>
                                        <Switch model={[st.on, m.id]} label={m.name} name={`project-feature-${m.id}-on`} disabled={!!props.busy} onCheckedChange={(on: boolean) => toggleFeature(m, on)} />
                                        <span data-project-feature-description>{m.description}</span>
                                    </div>
                                    {enabled(m.id) && catalogue()[m.id]?.presets?.length ? (
                                        <div data-project-feature-presets role="group" aria-label={`${m.name} presets`}>
                                            <span data-project-feature-presets-label>Start from</span>
                                            {catalogue()[m.id]!.presets!.map((p) => (
                                                <Button key={p.id} intent="default" disabled={!!props.busy} label={p.description ? `${p.label}: ${p.description}` : p.label} onClick={() => applyPreset(m, p)}>{p.label}</Button>
                                            ))}
                                        </div>
                                    ) : null}
                                    {enabled(m.id) ? (
                                        <SchemaForm
                                            ref={(api: SchemaFormApi | null) => { apis[m.id] = api; }}
                                            schema={m.projectSettings}
                                            value={st.features[m.id]!}
                                            name={`feature-${m.id}`}
                                            disabled={!!props.busy}
                                            hideActions
                                            onSubmit={(settings: Record<string, unknown>) => { st.features = { ...st.features, [m.id]: settings }; }}
                                            onChange={(settings: Record<string, unknown>) => { st.live = { ...st.live, [m.id]: settings }; }}
                                        />
                                    ) : null}
                                    {enabled(m.id) && pluginErrors(m).length ? (
                                        <ErrorNote data-project-feature-errors=""><ul>{pluginErrors(m).map((e) => <li key={e}>{e}</li>)}</ul></ErrorNote>
                                    ) : null}
                                    {enabled(m.id) && catalogue()[m.id]?.previewSettings ? (
                                        <dl data-project-feature-preview aria-label={`What the ${m.name} settings do`}>
                                            {catalogue()[m.id]!.previewSettings!({ project: { name: st.name }, settings: settingsNow(m), ...(Object.values(st.folders)[0] ? { folder: Object.values(st.folders)[0]! } : {}) }).map((l) => (
                                                <div key={l.label} data-project-feature-preview-line><dt>{l.label}</dt><dd>{l.value}</dd></div>
                                            ))}
                                        </dl>
                                    ) : null}
                                </li>
                            ))}
                        </ul>
                    ) : <p data-panel-note>No project feature plugins are enabled.</p>}
                </section>

                {props.error || st.featureError ? <ErrorNote data-project-error="">{props.error || st.featureError}</ErrorNote> : null}
                <div data-project-actions>
                    <Button intent="primary" loading={props.busy} onClick={save}>{props.project ? 'Save project' : 'Create project'}</Button>
                    <Button intent="default" disabled={!!props.busy} onClick={() => emit('cancel')}>Cancel</Button>
                    {props.project ? <Button intent="danger" icon="trash" disabled={!!props.busy} onClick={() => { st.removing = true; }}>Delete project</Button> : null}
                </div>

                <FormDialog
                    model={() => st.finding !== null}
                    title={finding ? `Find the repo on ${finding.label}` : 'Find the repo'}
                    description={`Every checkout of ${o ?? 'the project'} under the environment's working roots.`}
                    submitLabel="Use this folder"
                    busy={found.status === 'loading'}
                    onSubmit={useMatch}
                    onCancel={closeFind}
                >
                    {found.status === 'loading' ? <p data-panel-note data-project-locate="loading">Searching…</p> : null}
                    {found.status === 'error' ? <ErrorNote data-project-locate="error">{found.error?.message ?? 'The machine could not search.'}</ErrorNote> : null}
                    {found.status === 'done' && !found.matches.length ? <p data-panel-note data-project-locate="empty">No checkout of that repo under the roots. Browse to one, or clone it there first.</p> : null}
                    {found.status === 'done' && found.matches.length ? (
                        <Field.Root>
                            <Field.Label visuallyHidden>Checkouts found</Field.Label>
                            <RadioGroup.Root model={matchModel} name="project-locate-match" data-project-locate="matches">
                                {found.matches.map((m) => (
                                    <RadioGroup.Item value={m.path} data-project-match="">
                                        <span data-project-match-path>{m.path}</span>
                                        <Tag>{gitBadgeText(m.git)}</Tag>
                                    </RadioGroup.Item>
                                ))}
                            </RadioGroup.Root>
                        </Field.Root>
                    ) : null}
                    {found.status === 'done' && found.truncated ? <p data-panel-note data-project-locate="truncated">Only the first matches are listed; browse for one deeper down.</p> : null}
                </FormDialog>
                {props.project ? (
                    <ConfirmDialog
                        model={() => st.removing}
                        title={`Delete ${props.project.name}?`}
                        description="Chats, tasks and schedules that name it keep the id and show it as removed; nothing on any machine is touched."
                        confirmLabel="Delete project"
                        onConfirm={() => { st.removing = false; emit('remove'); }}
                        onCancel={() => { st.removing = false; }}
                    />
                ) : null}
            </div>
        );
    };
});
