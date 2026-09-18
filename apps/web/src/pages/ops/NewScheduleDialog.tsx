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
    & Define.Event<'create', NewScheduleInput>
    & Define.Event<'cancel'>;

const KINDS: readonly { value: ScheduleKind; label: string }[] = [
    { value: 'reminder', label: 'Reminder — once, to the inbox' },
    { value: 'recurring', label: 'Recurring reminder' },
    { value: 'agent-task', label: 'Agent task' }
];

/**
 * "New schedule" (AST-02): a reminder at a wall time on the workspace clock,
 * or a cron recurrence — plain to the inbox, or an agent task with a prompt
 * and an optional environment (AST-05). Confirming with a field missing
 * keeps the dialog open with the field marked.
 */
export const NewScheduleDialog = component<NewScheduleDialogProps>(({ props, emit }) => {
    const st = signal<{ -readonly [K in keyof NewScheduleInput]-?: NonNullable<NewScheduleInput[K]> } & { attempted: boolean }>({ kind: 'reminder', title: '', at: '', cron: '0 9 * * 1-5', agentId: '', environmentId: '', workdir: '', prompt: '', attempted: false });
    const input = (): NewScheduleInput => ({ kind: st.kind, title: st.title, at: st.at, cron: st.cron, agentId: st.agentId, environmentId: st.environmentId, workdir: st.workdir, prompt: st.prompt });
    // A folder belongs to its environment: choosing another one in the select drops it.
    let picking = false;
    watch(() => st.environmentId, () => { if (picking) picking = false; else st.workdir = ''; });
    return () => {
        const errors: NewScheduleErrors = st.attempted ? validateNewSchedule(input(), props.timeZone) : {};
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
                            <SelectField model={() => st.environmentId} name="schedule-environment" label="Environment" options={[{ value: '', label: 'platform (no machine needed)' }, ...props.environments]} description="An offline machine queues the task until it returns." />
                            {props.workdirs ? (
                                <WorkdirInput
                                    value={st.workdir && st.environmentId ? { environmentId: st.environmentId as EnvironmentId, path: st.workdir } : null}
                                    environments={props.workdirs.list()}
                                    machineOf={props.workdirs.machineOf}
                                    preferred={(st.environmentId || null) as EnvironmentId | null}
                                    label="Working folder"
                                    description="Where each run works. Empty: the environment's first working root."
                                    name="schedule-workdir"
                                    onChange={(ref) => {
                                        if (ref && ref.environmentId !== st.environmentId) {
                                            picking = true;
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
