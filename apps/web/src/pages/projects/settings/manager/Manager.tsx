/**
 * Settings › Project manager (#760, PRJ-14; the PMSettings board). Left: the project's own manager agent — its name,
 * the runtime note, its personality with a preview of its opening lines, its skills — with **Change**, which edits
 * this manager (`Workspace.updateProjectManager`, a new config version) and never swaps in another project's agent;
 * who can send requests; keeping you in the loop. Right: what the manager may do without asking, and the tools it
 * gets. The policy's Save sends `pmPolicy` through `upsertProject`; the agent is kept.
 */
import { component, signal, watch } from 'sigx';
import { PM_PERSONALITIES, PM_POLICY_DEFAULT, type ProjectRecord } from '@agentic/core';
import { RadioGroup } from '@sigx/zero';
import { Field } from '@sigx/zero-daisyui/components';
import { Button, CardSkeleton, ChipInput, ErrorNote, SelectField, Switch, TextField, TextareaField } from '@agentic/ui';
import type { ProjectPageProps } from '../../layout/types';
import { CUSTOM_PERSONALITY, PERSONALITY_SAMPLES } from '../../new/model';
import { useTabSave } from '../general/sources';
import {
    AUTONOMY_ROWS,
    MANAGER_TOOLS,
    WEEKDAYS,
    addSenderProject,
    autonomyLabel,
    managerDraftOf,
    managerPatchOf,
    managerSpecOf,
    openingLines,
    personalityLabel,
    policyDraftOf,
    policyOf,
    removeSenderProject,
    runtimeNote,
    senderMembers,
    validateManagerDraft,
    validatePolicyDraft,
    whoLabel,
    type PmAgent
} from './model';
import { useManagerSource } from './sources';

const initials = (name: string): string => name.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase() || 'PM';
const DAY_OPTIONS = WEEKDAYS.map((label, i) => ({ value: String(i), label }));

export const ProjectManager = component<ProjectPageProps>(({ props }) => {
    const source = useManagerSource(() => props.project);
    const save = useTabSave();
    const policyOfProject = (p: ProjectRecord) => p.pm?.policy ?? PM_POLICY_DEFAULT;
    const pol = signal({ ...policyDraftOf(policyOfProject(props.project)), adding: '', addingWho: {} as Record<string, boolean>, attempted: false });
    const ed = signal({ ...managerDraftOf(null), editing: false, attempted: false, busy: false, error: '', saved: false });
    watch(() => props.project.id, () => {
        Object.assign(pol, { ...policyDraftOf(policyOfProject(props.project)), adding: '', addingWho: {}, attempted: false });
        Object.assign(ed, { editing: false, attempted: false, error: '', saved: false });
    });

    const openEditor = (agent: PmAgent | null): void => {
        Object.assign(ed, { ...managerDraftOf(agent), editing: true, attempted: false, error: '', saved: false });
    };
    const saveManager = async (): Promise<void> => {
        ed.attempted = true;
        if (ed.busy || Object.keys(validateManagerDraft(ed)).length) return;
        const agent = source.agent();
        ed.busy = true;
        ed.error = '';
        try {
            if (agent) {
                const patch = managerPatchOf(ed, agent);
                if (patch) await source.update(patch);
            } else {
                await source.create(managerSpecOf(ed));
            }
            Object.assign(ed, { editing: false, saved: true });
        } catch (e) {
            ed.error = e instanceof Error ? e.message : String(e);
        } finally {
            ed.busy = false;
        }
    };
    const policyPatch = () => ({ id: props.project.id, pmPolicy: policyOf(pol) });
    const savePolicy = (): void => {
        pol.attempted = true;
        if (validatePolicyDraft(pol)) return;
        void save.run(policyPatch());
    };

    const editor = (hasAgent: boolean) => {
        const errors = ed.attempted ? validateManagerDraft(ed) : {};
        return (
            <div data-pm-editor="">
                <TextField model={() => ed.name} name="pm-name" label="Name" required error={errors.name} description="Members see it in chats and on the plan." />
                <Field.Root invalid={!!errors.personality}>
                    <Field.Label>Personality</Field.Label>
                    <RadioGroup.Root model={() => ed.personality} name="pm-personality" data-pm-personalities="">
                        {PM_PERSONALITIES.map((p) => (
                            <RadioGroup.Item key={p.id} value={p.id} data-pm-personality={p.id}>
                                <span data-pm-personality-label>{p.label}</span>
                                <span data-pm-personality-summary>{p.summary}</span>
                                <span data-pm-personality-sample>{PERSONALITY_SAMPLES[p.id] ?? ''}</span>
                            </RadioGroup.Item>
                        ))}
                        <RadioGroup.Item value={CUSTOM_PERSONALITY} data-pm-personality={CUSTOM_PERSONALITY}>
                            <span data-pm-personality-label>Custom</span>
                            <span data-pm-personality-summary>Write how it works in your own words.</span>
                        </RadioGroup.Item>
                    </RadioGroup.Root>
                    {errors.personality ? <Field.Error>{errors.personality}</Field.Error> : null}
                </Field.Root>
                {ed.personality === CUSTOM_PERSONALITY
                    ? <TextareaField model={() => ed.custom} name="pm-custom" label="How it works" rows={3} placeholder="You are a pragmatic project manager who…" />
                    : null}
                <p data-pm-preview="">
                    <span>Opens like</span> {openingLines(ed.personality === CUSTOM_PERSONALITY ? { custom: ed.custom } : { preset: ed.personality }) || '—'}
                </p>
                <Field.Root>
                    <Field.Label>Skills</Field.Label>
                    <ChipInput model={() => ed.skills} name="pm-skills" options={source.skillOptions()} allowCustom placeholder="Add a skill…" />
                </Field.Root>
                {ed.error ? <ErrorNote data-pm-error="">{ed.error}</ErrorNote> : null}
                <div data-project-actions>
                    <Button intent="primary" loading={ed.busy} onClick={() => { void saveManager(); }}>{hasAgent ? 'Save manager' : 'Create manager'}</Button>
                    <Button intent="default" disabled={ed.busy} onClick={() => { ed.editing = false; }}>Cancel</Button>
                </div>
            </div>
        );
    };

    const managerCard = () => {
        const agent = source.agent();
        return (
            <section data-pm-card="agent" aria-label="Project manager">
                <h3>Project manager</h3>
                {source.loading && !agent ? <CardSkeleton lines={3} label="Loading the project manager" /> : agent ? (
                    <>
                        <div data-pm-agent={agent.id}>
                            <span data-pm-avatar aria-hidden="true">{initials(agent.name)}</span>
                            <div data-pm-agent-text>
                                <strong data-pm-name>{agent.name}</strong>
                                <span data-pm-runtime>{runtimeNote(agent.runtime)}</span>
                            </div>
                            {ed.editing ? null : <Button intent="default" onClick={() => openEditor(agent)}>Change</Button>}
                        </div>
                        <p data-pm-note="">The project manager is this project's coordinator. It owns the Plan, assigns work to members, and is who other projects talk to.</p>
                        {ed.editing ? editor(true) : (
                            <dl data-pm-facts="">
                                <dt>Personality</dt>
                                <dd data-pm-personality-now>{personalityLabel(agent.personality)}</dd>
                                {openingLines(agent.personality) ? <><dt>Opens like</dt><dd data-pm-opening>{openingLines(agent.personality)}</dd></> : null}
                                <dt>Skills</dt>
                                <dd data-pm-skills-now>{agent.skills.length ? agent.skills.map((s) => <span data-pm-skill={s}>{s}</span>) : <span data-pm-muted>none</span>}</dd>
                            </dl>
                        )}
                        {ed.saved && !ed.editing ? <span data-project-saved role="status">Saved.</span> : null}
                    </>
                ) : (
                    <>
                        <p data-pm-empty="">This project has no project manager yet. Requests from other projects go to a person until it has one.</p>
                        {ed.editing ? editor(false) : <Button intent="primary" onClick={() => openEditor(null)}>Add a project manager</Button>}
                    </>
                )}
            </section>
        );
    };

    const sendersCard = () => {
        const nameOfProject = (id: string): string => source.projects().find((p) => p.id === id)?.name ?? id;
        const named = pol.senders.filter((r) => r.project !== '*');
        const addable = source.projects().filter((p) => p.id !== props.project.id && !pol.senders.some((r) => r.project === p.id));
        // The members a new rule can name (#942): none picked lets any member of the project send.
        const members = pol.adding ? senderMembers(source.projects().find((p) => p.id === pol.adding), source.nameOf) : [];
        const add = (): void => {
            const picked = members.filter((m) => pol.addingWho[m.id]).map((m) => m.id);
            addSenderProject(pol, pol.adding, picked);
            pol.adding = '';
            pol.addingWho = {};
        };
        return (
            <section data-pm-card="senders" aria-label="Who can send requests">
                <h3>Who can send requests</h3>
                <ul data-pm-senders="">
                    {named.map((r) => (
                        <li data-pm-sender={r.project}>
                            <span data-pm-sender-project>{nameOfProject(r.project)}</span>
                            <span data-pm-sender-who>{whoLabel(r.who, source.nameOf)}</span>
                            <span data-pm-sender-mode>{pol.allowed[r.project] ? 'allowed' : 'ask me first'}</span>
                            <Switch model={[pol.allowed, r.project]} label={`Requests from ${nameOfProject(r.project)} go straight to triage`} hideLabel name={`pm-sender-${r.project}`} />
                            <Button intent="icon" icon="trash" label={`Remove ${nameOfProject(r.project)}`} onClick={() => removeSenderProject(pol, r.project)} />
                        </li>
                    ))}
                    <li data-pm-sender="*">
                        <span data-pm-sender-project>Any other project</span>
                        <span data-pm-sender-who>any member</span>
                        <span data-pm-sender-mode>{pol.allowed['*'] ? 'allowed' : 'ask me first'}</span>
                        <Switch model={[pol.allowed, '*']} label="Requests from any other project go straight to triage" hideLabel name="pm-sender-other" />
                    </li>
                </ul>
                {addable.length ? (
                    <div data-pm-sender-add="">
                        <SelectField model={() => pol.adding} name="pm-sender-add" label="Let a project send straight to triage" placeholder="Pick a project" options={addable.map((p) => ({ value: p.id, label: p.name }))} />
                        {members.length ? (
                            <fieldset data-pm-sender-who-pick="">
                                <legend>Only these members</legend>
                                <span data-pm-row-hint>{`None picked: any member of ${nameOfProject(pol.adding)}.`}</span>
                                {members.map((m) => (
                                    <div data-pm-sender-member={m.id}>
                                        <span data-pm-row-label>{m.name}</span>
                                        <Switch model={[pol.addingWho, m.id]} label={`${m.name} may send`} hideLabel name={`pm-sender-member-${m.id}`} />
                                    </div>
                                ))}
                            </fieldset>
                        ) : null}
                        <Button intent="default" disabled={!pol.adding} onClick={add}>Add</Button>
                    </div>
                ) : null}
            </section>
        );
    };

    const loopCard = () => {
        const error = pol.attempted ? validatePolicyDraft(pol) : '';
        return (
            <section data-pm-card="loop" aria-label="Keeping you in the loop">
                <h3>Keeping you in the loop</h3>
                <div data-pm-row="weekly">
                    <span data-pm-row-label>Weekly summary on Home</span>
                    <Switch model={() => pol.weekly} label="Weekly summary on Home" hideLabel name="pm-weekly" />
                </div>
                {pol.weekly ? (
                    <div data-pm-weekly="">
                        <SelectField model={() => pol.day} name="pm-weekly-day" label="Day" options={DAY_OPTIONS} />
                        <TextField model={() => pol.time} name="pm-weekly-time" label="Time" placeholder="HH:MM" error={error || undefined} />
                    </div>
                ) : null}
                <div data-pm-row="merge">
                    <span data-pm-row-label>Tell requesters when their item merges</span>
                    <Switch model={() => pol.notifyOnMerge} label="Tell requesters when their item merges" hideLabel name="pm-notify-merge" />
                </div>
            </section>
        );
    };

    const autonomyCard = () => {
        const name = source.agent()?.name ?? 'the project manager';
        return (
            <section data-pm-card="autonomy" aria-label="What it may do without asking">
                <h3>What {name} may do without asking</h3>
                <ul data-pm-autonomy="">
                    {AUTONOMY_ROWS.map((row) => (
                        <li data-pm-autonomy-row={row.key}>
                            <div data-pm-row-text>
                                <span data-pm-row-label>{autonomyLabel(row, pol)}</span>
                                <span data-pm-row-hint>{row.hint}</span>
                            </div>
                            {row.key === 'priority'
                                ? <Switch model={() => pol.priority} label={autonomyLabel(row, pol)} hideLabel name="pm-autonomy-priority" />
                                : <Switch model={[pol.autonomy, row.key]} label={row.label} hideLabel name={`pm-autonomy-${row.key}`} />}
                        </li>
                    ))}
                </ul>
            </section>
        );
    };

    const toolsCard = () => (
        <section data-pm-card="tools" aria-label="Tools it gets">
            <h3>Tools it gets</h3>
            <dl data-pm-tools="">
                {MANAGER_TOOLS.map((t) => <div data-pm-tool={t.name}><dt>{t.name}</dt><dd>{t.what}</dd></div>)}
            </dl>
        </section>
    );

    return () => {
        const s = save.state;
        const patch = policyPatch();
        return (
            <section aria-label="Project manager" data-settings-tab="manager" data-project-settings="">
                <h2>Project manager</h2>
                <div data-pm-settings="">
                    <div data-pm-column="">
                        {managerCard()}
                        {sendersCard()}
                        {loopCard()}
                    </div>
                    <div data-pm-column="">
                        {autonomyCard()}
                        {toolsCard()}
                    </div>
                </div>
                {s.error ? <ErrorNote data-project-error="">{s.error}</ErrorNote> : null}
                <div data-project-actions>
                    <Button intent="primary" loading={s.busy} onClick={savePolicy}>Save policy</Button>
                    {s.saved && s.saved === JSON.stringify(patch) && !s.error ? <span data-project-saved role="status">Saved.</span> : null}
                </div>
            </section>
        );
    };
}, { name: 'ProjectManager' });
