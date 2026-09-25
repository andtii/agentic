/**
 * Settings › Folders (#733, the old project form's folder rows, #702): one row per paired machine — every environment
 * on it whose roots hold the folder runs there — with an override per environment on demand. Browse goes through the
 * picker scoped to the machine's environments; Find through `locate` once another row's badge says which repo this
 * is. A row whose checkout is of another repo warns and never blocks. Saved on its own as the `folders` patch.
 */
import { component, signal, watch } from 'sigx';
import { parseProjectFolderKey, projectFolderKey, type EnvironmentId, type FsGitInfo, type MachineId } from '@agentic/core';
import { derivedModel } from '@sigx/zero/behaviors';
import { RadioGroup } from '@sigx/zero';
import { Field } from '@sigx/zero-daisyui/components';
import { Button, ErrorNote, FormDialog, Tag, gitBadgeText, type WorkdirEnvironment, type WorkdirSelection } from '@agentic/ui';
import { WorkdirInput } from '../../../workdir/WorkdirInput';
import type { ProjectPageProps } from '../../layout/types';
import { hasUnplacedFolders, originMismatch, originOf, projectDraftOf, reaches, resolveFolders, type ProjectMachine } from '../../model';
import { useFoldersSource, useTabSave } from '../general/sources';
import { TabFrame, tabPatchOf } from '../general/TabFrame';

/** A row's badge; a stored folder has none until it is picked again, a prefilled one carries the origin and no HEAD. */
const badgeText = (git: FsGitInfo): string => (git.branch || git.head ? gitBadgeText(git) : git.kind);

export const ProjectFolders = component<ProjectPageProps>(({ props }) => {
    const save = useTabSave();
    const source = useFoldersSource();
    const locate = source.locate;
    const st = signal({
        ...projectDraftOf(props.project),
        overrides: {} as Record<string, boolean>,
        finding: null as { key: string; environmentId: EnvironmentId; label: string } | null,
        match: ''
    });
    watch(() => props.project.id, () => Object.assign(st, projectDraftOf(props.project), { overrides: {}, finding: null, match: '' }));
    // A folder keyed by a bare environment id (a pre-#702 project) is placed on its machine once the machines are known.
    watch(
        () => [source.machines(), st.folders] as const,
        () => {
            const machines = source.machines();
            if (hasUnplacedFolders(st.folders) && machines.length) st.folders = resolveFolders(st.folders, machines);
        },
        { immediate: true }
    );
    const setFolder = (key: string, pick: WorkdirSelection | null): void => {
        const next = { ...st.folders };
        if (pick) next[key] = { path: pick.path, ...(pick.git ? { git: pick.git } : {}) };
        else delete next[key];
        st.folders = next;
    };
    const find = (key: string, machine: ProjectMachine, env: WorkdirEnvironment | undefined): void => {
        const o = originOf(st.folders);
        if (!o || !env) return;
        st.match = '';
        st.finding = { key, environmentId: env.id, label: parseProjectFolderKey(key)?.environmentId ? env.label : machine.name };
        locate.start(env.id, o, machine.id);
    };
    const closeFind = (): void => {
        st.finding = null;
        locate.reset();
    };
    /** The match in effect: the picked one, else the first (the radios show it checked). */
    const matchInEffect = (): string => st.match || (locate.state.matches[0]?.path ?? '');
    const matchModel = derivedModel<string>(matchInEffect, (path) => { st.match = path; });
    /** Confirm: fill the row with the match; while there is none the dialog stays, its results in view. */
    const useMatch = (): void => {
        const at = st.finding;
        const hit = locate.state.matches.find((m) => m.path === matchInEffect());
        if (!at || !hit) return;
        setFolder(at.key, { environmentId: at.environmentId, path: hit.path, git: hit.git });
        closeFind();
    };

    return () => {
        const machines = source.machines();
        const o = originOf(st.folders);
        const finding = st.finding;
        const found = locate.state;
        const busy = save.state.busy;
        return (
            <TabFrame
                tab="folders"
                title="Folders"
                hint="Where the project lives on each machine. Every environment on the machine runs there, unless it has its own folder here or a chat member is given another one in the chat."
                save={save}
                patch={tabPatchOf(st, props.project, ['folders'])}
                onSubmit={() => { void save.run(tabPatchOf(st, props.project, ['folders'])); }}
            >
                {machines.length ? (
                    <ul data-project-folders>
                        {machines.map((m) => {
                            const key = projectFolderKey(m.id as MachineId);
                            const row = st.folders[key];
                            const mismatch = originMismatch(st.folders, key);
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
                                        disabled={busy || !m.environments.length}
                                        onChange={(pick) => setFolder(key, pick)}
                                    />
                                    <span data-project-folder-meta>
                                        {row?.git ? <Tag>{badgeText(row.git)}</Tag> : null}
                                        {!row && o ? <Button intent="default" icon="search" disabled={busy || !browsable} onClick={() => find(key, m, browsable)}>Find</Button> : null}
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
                                                            disabled={busy}
                                                            onChange={(pick) => setFolder(okey, pick)}
                                                        />
                                                        {!own && row && !inherits ? <span data-project-folder-note>The machine's folder is outside this environment's folders ({env.roots.join(', ') || 'none'}): it runs in its first folder unless you pick one here.</span> : null}
                                                        {!own && o && !env.unavailable ? <Button intent="default" icon="search" disabled={busy} onClick={() => find(okey, m, env)}>Find</Button> : null}
                                                    </li>
                                                );
                                            })}
                                        </ul>
                                    ) : null}
                                </li>
                            );
                        })}
                    </ul>
                ) : <p data-panel-note>No machine is paired yet — a project without folders runs on the platform.</p>}

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
            </TabFrame>
        );
    };
}, { name: 'ProjectFolders' });
