/**
 * The project form (#333): name and description, the roster on the New
 * chat member cards with the coordinator radio, the connectors as chips,
 * one folder row per daemon environment (Browse through the picker scoped
 * to that environment; Find through `locate` once another row's badge
 * says which repo this is), and the feature plugins as switches whose
 * settings render from the manifest's `projectSettings` schema. A folder's
 * git badge stays on its row; a plugin's `detect` suggests the feature;
 * a row whose checkout is of another repo warns and never blocks.
 */
import { component, signal, watch, type Define } from 'sigx';
import type { EnvironmentId, ProjectFeatureManifest, ProjectFeaturePlugin, ProjectPatch, ProjectRecord } from '@agentic/core';
import { Button, ChipInput, ConfirmDialog, Label, SchemaForm, Switch, Tag, TextField, TextareaField, gitBadgeText, type SchemaFormApi, type WorkdirEnvironment, type WorkdirSelection } from '@agentic/ui';
import { projectFeatureCatalogue } from '../../plugins/catalogue';
import { MemberPicker } from '../chat/MemberPicker';
import type { AgentIdentity } from '../chat/live';
import { WorkdirInput } from '../workdir/WorkdirInput';
import type { LocateBackend } from './locate';
import { detectedFeatures, originMismatch, originOf, projectDraftOf, projectPatchOf, validateProjectDraft, withOrigin, type ProjectDraft, type ProjectErrors } from './model';

export type ProjectFormProps =
    /** The project being edited; absent on the New project page. */
    & Define.Prop<'project', ProjectRecord>
    & Define.Prop<'agents', readonly AgentIdentity[], true>
    /** Every daemon environment: one folder row each; the quota badges on the member cards. */
    & Define.Prop<'environments', readonly WorkdirEnvironment[], true>
    & Define.Prop<'machineOf', (environmentId: string) => string | undefined>
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
    const st = signal<ProjectDraft & { attempted: boolean; finding: EnvironmentId | null; match: string; detected: Record<string, string[]>; removing: boolean; featureError: string; on: Record<string, boolean> }>({
        ...projectDraftOf(props.project),
        on: onOf(props.project?.features ?? {}),
        attempted: false,
        finding: null,
        match: '',
        detected: {},
        removing: false,
        featureError: ''
    });
    // The project landed after the form mounted (a live read): open on it, unless the person has started typing.
    watch(
        () => props.project?.id,
        () => {
            if (props.project && !st.name) Object.assign(st, projectDraftOf(props.project), { on: onOf(props.project.features) });
        }
    );
    const apis: Record<string, SchemaFormApi | null> = {};
    const catalogue = (): Readonly<Record<string, ProjectFeaturePlugin>> => props.catalogue ?? projectFeatureCatalogue;
    const features = (): readonly ProjectFeatureManifest[] => props.features ?? [];
    const origin = (): string | undefined => originOf(st.folders);
    const enabled = (id: string): boolean => Object.hasOwn(st.features, id);

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
    const setFolder = (environmentId: EnvironmentId, pick: WorkdirSelection | null): void => {
        const next = { ...st.folders };
        const detected = { ...st.detected };
        if (pick) {
            next[environmentId] = { path: pick.path, ...(pick.git ? { git: pick.git } : {}) };
            const found = pick.git ? detectedFeatures(catalogue(), { path: pick.path, git: pick.git }) : [];
            detected[environmentId] = found;
            // A project with no feature yet takes the suggestion; one that has chosen keeps its choice.
            if (found.length && !Object.keys(st.features).length) for (const id of found) { const m = features().find((f) => f.id === id); if (m) toggleFeature(m, true); }
        } else {
            delete next[environmentId];
            delete detected[environmentId];
        }
        st.folders = next;
        st.detected = detected;
        prefillOrigins();
    };
    const find = (environmentId: EnvironmentId): void => {
        const o = origin();
        if (!o) return;
        st.match = '';
        st.finding = environmentId;
        props.locate.start(environmentId, o);
    };
    const closeFind = (): void => {
        st.finding = null;
        props.locate.reset();
    };
    /** The match in effect: the picked one, else the first (the radios show it checked). */
    const matchInEffect = (): string => st.match || (props.locate.state.matches[0]?.path ?? '');
    /** Confirm: fill the row with the match — while there is none (still searching, an error, nothing found) the dialog stays, its results in view. */
    const useMatch = (): void => {
        const env = st.finding;
        const hit = props.locate.state.matches.find((m) => m.path === matchInEffect());
        if (!env || !hit) return;
        setFolder(env, { environmentId: env, path: hit.path, git: hit.git });
        closeFind();
    };
    const save = (): void => {
        st.attempted = true;
        if (Object.keys(validateProjectDraft(st)).length) return;
        // Each enabled feature's settings form checks its own draft; a refused one keeps the page here with its fields marked.
        for (const m of features()) {
            if (!enabled(m.id)) continue;
            const api = apis[m.id];
            if (api && !api.submit()) {
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
        const finding = st.finding ? props.environments.find((e) => e.id === st.finding) : undefined;
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
                    <p data-project-hint>Where the project lives on each machine. A chat member runs in the folder of its environment unless it is given another one in the chat.</p>
                    {props.environments.length ? (
                        <ul data-project-folders>
                            {props.environments.map((env) => {
                                const row = st.folders[env.id];
                                const mismatch = originMismatch(st.folders, env.id);
                                const detected = st.detected[env.id] ?? [];
                                return (
                                    <li data-project-folder={env.id} data-mismatch={mismatch ? '' : undefined}>
                                        <WorkdirInput
                                            value={row ? { environmentId: env.id, path: row.path } : null}
                                            environments={[env]}
                                            {...(props.machineOf ? { machineOf: props.machineOf } : {})}
                                            preferred={env.id}
                                            label={env.label}
                                            placeholder="No folder on this environment"
                                            name={`project-folder-${env.id}`}
                                            disabled={!!props.busy}
                                            onChange={(pick) => setFolder(env.id, pick)}
                                        />
                                        <span data-project-folder-meta>
                                            {row?.git ? <Tag>{gitBadgeText(row.git)}</Tag> : null}
                                            {detected.map((id) => <Tag tone="live">{features().find((f) => f.id === id)?.name ?? id}</Tag>)}
                                            {!row && o ? <Button intent="default" icon="search" disabled={!!props.busy || !!env.unavailable} onClick={() => find(env.id)}>Find</Button> : null}
                                            {!row && o && env.unavailable ? <span data-project-folder-note>{env.unavailable}</span> : null}
                                        </span>
                                        {mismatch ? <p data-project-folder-warning role="status">This checkout has another origin ({row!.git!.origin}) than the rest of the project.</p> : null}
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
                                    {enabled(m.id) ? (
                                        <SchemaForm
                                            ref={(api: SchemaFormApi | null) => { apis[m.id] = api; }}
                                            schema={m.projectSettings}
                                            value={st.features[m.id]!}
                                            name={`feature-${m.id}`}
                                            disabled={!!props.busy}
                                            hideActions
                                            onSubmit={(settings: Record<string, unknown>) => { st.features = { ...st.features, [m.id]: settings }; }}
                                        />
                                    ) : null}
                                </li>
                            ))}
                        </ul>
                    ) : <p data-panel-note>No project feature plugins are enabled.</p>}
                </section>

                {props.error || st.featureError ? <p data-project-error role="alert">{props.error || st.featureError}</p> : null}
                <div data-project-actions>
                    <Button intent="primary" loading={props.busy} onClick={save}>{props.project ? 'Save project' : 'Create project'}</Button>
                    <Button intent="default" disabled={!!props.busy} onClick={() => emit('cancel')}>Cancel</Button>
                    {props.project ? <Button intent="danger" icon="trash" disabled={!!props.busy} onClick={() => { st.removing = true; }}>Delete project</Button> : null}
                </div>

                <ConfirmDialog
                    model={() => st.finding !== null}
                    title={finding ? `Find the repo on ${finding.label}` : 'Find the repo'}
                    description={`Every checkout of ${o ?? 'the project'} under the environment's working roots.`}
                    confirmLabel="Use this folder"
                    danger={false}
                    busy={found.status === 'loading'}
                    onConfirm={useMatch}
                    onCancel={closeFind}
                >
                    {found.status === 'loading' ? <p data-panel-note data-project-locate="loading">Searching…</p> : null}
                    {found.status === 'error' ? <p data-project-locate="error" role="alert">{found.error?.message ?? 'The machine could not search.'}</p> : null}
                    {found.status === 'done' && !found.matches.length ? <p data-panel-note data-project-locate="empty">No checkout of that repo under the roots. Browse to one, or clone it there first.</p> : null}
                    {found.status === 'done' && found.matches.length ? (
                        <ul data-project-locate="matches">
                            {found.matches.map((m) => (
                                <li>
                                    <label data-project-match>
                                        <input type="radio" name="project-locate-match" value={m.path} checked={matchInEffect() === m.path} onChange={() => { st.match = m.path; }} />
                                        <span data-project-match-path>{m.path}</span>
                                        <Tag>{gitBadgeText(m.git)}</Tag>
                                    </label>
                                </li>
                            ))}
                        </ul>
                    ) : null}
                    {found.status === 'done' && found.truncated ? <p data-panel-note data-project-locate="truncated">Only the first matches are listed; browse for one deeper down.</p> : null}
                </ConfirmDialog>
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
