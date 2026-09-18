import { component, signal, watch, type Define } from 'sigx';
import type { EnvironmentId, WorkdirRef } from '@agentic/core';
import { ConfirmDialog, SelectField, TextareaField } from '@agentic/ui';
import type { AgentIdentity } from '../chat/live';
import type { WorkdirEnvironments } from '../workdir/environments';
import { WorkdirInput } from '../workdir/WorkdirInput';
import { validateStartTask, type StartTaskInput } from './start';

export type StartTaskDialogProps =
    & Define.Model<boolean>
    & Define.Prop<'agents', readonly AgentIdentity[], true>
    /** The agent chosen when it opens (an agent's own page). */
    & Define.Prop<'agentId', string>
    & Define.Prop<'workdirs', WorkdirEnvironments, true>
    & Define.Prop<'busy', boolean>
    & Define.Prop<'error', string>
    & Define.Event<'start', StartTaskInput>
    & Define.Event<'cancel'>;

/** A daemon agent's identity names its default environment where a platform one names `platform` (`identityOf`). */
const defaultEnvironmentOf = (a: AgentIdentity | undefined): EnvironmentId | null => (a && a.environment.runtime !== 'anthropic-api' ? (a.environment.machine as EnvironmentId) : null);

/**
 * "Start task" (#193, AGT-05): which agent, what it should do and — for an
 * agent that runs on a machine — where. The folder picks the environment
 * with it; left empty, the agent's defaults apply. It opens a chat with the
 * agent, so the work can be followed up there.
 */
export const StartTaskDialog = component<StartTaskDialogProps>(({ props, emit }) => {
    const st = signal({ agentId: '', objective: '', workdir: null as WorkdirRef | null, attempted: false });
    // Opening starts over, on the agent the page named.
    watch(() => props.model?.value, (open) => {
        if (open) Object.assign(st, { agentId: props.agentId ?? '', objective: '', workdir: null, attempted: false });
    });
    // Another agent: its own defaults, not the last one's folder.
    watch(() => st.agentId, () => { st.workdir = null; });
    const input = (): StartTaskInput => ({ agentId: st.agentId, objective: st.objective, workdir: st.workdir });
    return () => {
        const errors = st.attempted ? validateStartTask(input()) : {};
        const agent = props.agents.find((a) => a.id === st.agentId);
        const onMachine = !!agent && agent.environment.runtime !== 'anthropic-api';
        return (
            <ConfirmDialog
                model={props.model}
                title="Start task"
                description="Opens a chat with the agent and posts the objective, so you can follow up there."
                confirmLabel="Start task"
                danger={false}
                busy={props.busy}
                onConfirm={() => {
                    st.attempted = true;
                    if (Object.keys(validateStartTask(input())).length) return;
                    emit('start', input());
                }}
                onCancel={() => emit('cancel')}
            >
                <div data-start-task-fields>
                    <SelectField model={() => st.agentId} name="task-agent" label="Agent" options={props.agents.map((a) => ({ value: a.id, label: a.role ? `${a.name} · ${a.role}` : a.name }))} placeholder="Pick an agent" required error={errors.agentId} />
                    <TextareaField model={() => st.objective} name="task-objective" label="Objective" rows={4} required error={errors.objective} description="What the agent should do. It becomes the chat's first message." />
                    {onMachine ? (
                        <WorkdirInput
                            value={st.workdir}
                            environments={props.workdirs.list()}
                            machineOf={props.workdirs.machineOf}
                            preferred={defaultEnvironmentOf(agent)}
                            label="Working folder"
                            description="Where it runs — the folder picks the environment too. Empty: the agent's default environment and folder."
                            placeholder="Agent's default"
                            name="task-workdir"
                            onChange={(ref) => { st.workdir = ref; }}
                        />
                    ) : agent ? <p data-start-task-note>{agent.name} runs on the platform: no machine, no folder.</p> : null}
                    {props.error ? <p data-start-task-error role="alert">{props.error}</p> : null}
                </div>
            </ConfirmDialog>
        );
    };
});
