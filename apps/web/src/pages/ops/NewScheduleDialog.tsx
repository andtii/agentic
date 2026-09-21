import { component, signal, watch, type Define } from 'sigx';
import type { EnvironmentId } from '@agentic/core';
import { ConfirmDialog, SelectField, TextareaField, TextField } from '@agentic/ui';
import type { ScheduleKind } from '../../mock/ops';
import { validateNewSchedule, type NewScheduleErrors, type NewScheduleInput } from './live';
import type { WorkdirEnvironments } from '../workdir/environments';
import { WorkdirInput } from '../workdir/WorkdirInput';

export type NewScheduleDialogProps =
    & Define.Model<boolean>
    & Define.Prop<'timeZone', string, true>
    & Define.Prop<'agents', readonly { value: string; label: string }[], true>
    & Define.Prop<'environments', readonly { value: string; label: string }[], true>
    & Define.Prop<'busy', boolean>
    /** Where an agent task's folder can be picked (#193); absent, the dialog asks for none. */
    & Define.Prop<'workdirs', WorkdirEnvironments>
    /** The workspace's projects (#333): a third, exclusive way to say where an agent task runs; absent or empty, no option. */
    & Define.Prop<'projects', readonly { value: string; label: string }[]>
    /** The paired machines (#414): "Machine" beside Environment, exclusive with it, compatible with a project. */
    & Define.Prop<'machines', readonly { value: string; label: string }[]>
    & Define.Event<'create', NewScheduleInput>
    & Define.Event<'cancel'>;

const KINDS: readonly { value: ScheduleKind; label: string }[] = [
    { value: 'reminder', label: 'Reminder — once, to the inbox' },
    { value: 'recurring', label: 'Recurring reminder' },
    { value: 'agent-task', label: 'Agent task' }
];

/** Where an agent task runs: in a project (its folder per environment), or on an environment with an optional folder. */
type PlaceMode = 'environment' | 'project';

/**
 * "New schedule" (AST-02): a reminder at a wall time on the workspace clock,
 * or a cron recurrence — plain to the inbox, or an agent task with a prompt
 * and an optional environment (AST-05), a folder in it (#193), or a project
 * instead of both (#333: a project says where the work lives, so choosing
 * one clears and disables the environment and the folder). Confirming with
 * a field missing keeps the dialog open with the field marked.
 */
export const NewScheduleDialog = component<NewScheduleDialogProps>(({ props, emit }) => {
    const st = signal<{ -readonly [K in keyof NewScheduleInput]-?: NonNullable<NewScheduleInput[K]> } & { attempted: boolean; mode: PlaceMode; sync: 'none' | 'folder' }>({ kind: 'reminder', title: '', at: '', cron: '0 9 * * 1-5', agentId: '', environmentId: '', workdir: '', projectId: '', machineId: '', prompt: '', attempted: false, mode: 'environment', sync: 'none' });
    const input = (): NewScheduleInput => ({ kind: st.kind, title: st.title, at: st.at, cron: st.cron, agentId: st.agentId, environmentId: st.environmentId, workdir: st.workdir, projectId: st.projectId, machineId: st.machineId, prompt: st.prompt });
    // A folder belongs to its environment: choosing another one in the select drops it — unless the folder picker itself set the environment (`sync`).
    watch(() => st.environmentId, () => { if (st.sync === 'folder') st.sync = 'none'; else st.workdir = ''; });
    // A project is exclusive with the environment and the folder (the actor refuses both): picking one clears them and the fields disable.
    watch(() => st.projectId, (id) => {
        st.mode = id || st.machineId ? 'project' : 'environment';
        if (id) {
            st.environmentId = '';
            st.workdir = '';
        }
    });
    // A machine names where the work runs (#414): exclusive with the environment and the folder too; a project may ride along.
    watch(() => st.machineId, (id) => {
        st.mode = id || st.projectId ? 'project' : 'environment';
        if (id) {
            st.environmentId = '';
            st.workdir = '';
        }
    });
    // An environment names its machine already: picking one drops the machine.
    watch(() => st.environmentId, (id) => { if (id && st.machineId) st.machineId = ''; });
    return () => {
        const errors: NewScheduleErrors = st.attempted ? validateNewSchedule(input(), props.timeZone) : {};
        const inProject = st.mode === 'project';
        return (
            <ConfirmDialog
                model={props.model}
                title="New schedule"
                description={`Times are ${props.timeZone}. Reminders are delivered by the platform, even with every machine offline.`}
                confirmLabel="Create schedule"
                danger={false}
                busy={props.busy}
                onConfirm={() => {
                    st.attempted = true;
                    if (Object.keys(validateNewSchedule(input(), props.timeZone)).length) return;
                    emit('create', input());
                }}
                onCancel={() => emit('cancel')}
            >
                <div data-new-schedule-fields>
                    <SelectField model={() => st.kind} name="schedule-kind" label="Kind" options={KINDS} />
                    <TextField model={() => st.title} name="schedule-title" label="Title" required error={errors.title} />
                    {st.kind === 'reminder'
                        ? <TextField model={() => st.at} name="schedule-at" label="When" placeholder="2026-09-18 15:00" description={`Date and time on the ${props.timeZone} clock.`} required error={errors.at} />
                        : <TextField model={() => st.cron} name="schedule-cron" label="Cron" description="minute hour day month weekday — 0 9 * * 1-5 is weekdays at 09:00." required error={errors.cron} />}
                    {st.kind === 'agent-task' ? (
                        <>
                            <SelectField model={() => st.agentId} name="schedule-agent" label="Agent" options={props.agents} placeholder="Pick an agent" required error={errors.agentId} />
                            {props.projects?.length ? (
                                <SelectField model={() => st.projectId} name="schedule-project" label="Project" options={[{ value: '', label: 'No project' }, ...props.projects]} description="In a project, each run works in the project's folder on the environment it lands on." />
                            ) : null}
                            {props.machines?.length ? (
                                <SelectField model={() => st.machineId} name="schedule-machine" label="Machine" options={[{ value: '', label: 'No particular machine' }, ...props.machines]} description="Each run goes to this machine, under the agent's account there." />
                            ) : null}
                            <SelectField model={() => st.environmentId} name="schedule-environment" label="Environment" options={[{ value: '', label: 'platform (no machine needed)' }, ...props.environments]} disabled={inProject} description={inProject ? (st.machineId ? 'The machine says where the work runs.' : 'The project says where the work lives.') : 'An offline machine queues the task until it returns.'} />
                            {props.workdirs ? (
                                <WorkdirInput
                                    value={st.workdir && st.environmentId ? { environmentId: st.environmentId as EnvironmentId, path: st.workdir } : null}
                                    environments={props.workdirs.list()}
                                    machineOf={props.workdirs.machineOf}
                                    preferred={(st.environmentId || null) as EnvironmentId | null}
                                    label="Working folder"
                                    description={inProject ? "The project's folder for the environment." : "Where each run works. Empty: the environment's first working root."}
                                    name="schedule-workdir"
                                    disabled={inProject}
                                    onChange={(ref) => {
                                        if (ref && ref.environmentId !== st.environmentId) {
                                            st.sync = 'folder';
                                            st.environmentId = ref.environmentId;
                                        }
                                        st.workdir = ref?.path ?? '';
                                    }}
                                />
                            ) : null}
                        </>
                    ) : null}
                    <TextareaField model={() => st.prompt} name="schedule-prompt" label={st.kind === 'agent-task' ? 'Prompt' : 'Note'} rows={3} description={st.kind === 'agent-task' ? 'What the agent is asked to do each time.' : 'Shown in the inbox with the reminder.'} />
                </div>
            </ConfirmDialog>
        );
    };
});
