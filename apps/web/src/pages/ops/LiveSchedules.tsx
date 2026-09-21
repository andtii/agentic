/**
 * `/schedules` on the platform (#145): the Workspace index's schedule ids,
 * each entry's `Schedule.get()` as a live read (its own row re-renders when
 * it fires or is switched), on the workspace time zone from the settings
 * (AST-07). The enable switch is `Schedule.enable` / `disable`; "New
 * schedule" (topbar → `newScheduleRequest`) is `Workspace.createSchedule`
 * then `Schedule.create(spec)` — the entry's own durable reminder delivers
 * it with no browser open (AST-03/04).
 */
import { component, effect, onUnmounted, signal, useHead, type JSXElement } from 'sigx';
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
import { AgentTile, DataTable, EmptyState, EnvironmentLine, Icon, Switch, Tag } from '@agentic/ui';
import { useActorDefs, useViewer, type ActorDefs } from '../../actors/defs';
import { scheduleKeyOf, workspaceKeyOf } from '../../actors/keys';
import type { OpsSchedule } from '../../mock/ops';
import { useAgentDirectory, type AgentDirectory } from '../chat/directory';
import { useEnvironmentDirectory, type EnvironmentDirectory } from './environments';
import { closeNewSchedule, newScheduleRequest } from './head';
import { dstRuleFor, newScheduleSpec, SCHEDULES_COLS, scheduleRow, type NewScheduleInput } from './live';
import { NewScheduleDialog } from './NewScheduleDialog';
import { useProjects } from '../projects/live';
import { useLiveWorkdirEnvironments } from '../workdir/environments';
import { OpsPage } from './OpsPage';

/** Create the entry in `ws`: an indexed id, then the Schedule actor under it. Resolves to the new id. */
export async function createScheduleWith(defs: ActorDefs, ws: string, input: NewScheduleInput, tz: string): Promise<string> {
    const spec = newScheduleSpec(input, tz);
    if (!spec) throw new Error('The schedule is incomplete.');
    const { scheduleId } = await actor(defs.Workspace, workspaceKeyOf(ws)).createSchedule();
    await actor(defs.Schedule, scheduleKeyOf(ws, scheduleId)).create(spec);
    return scheduleId;
}

/** Where a schedule runs: the platform needs no machine; an agent task names its tile and environment line. */
const RunsOn = component<{ schedule: OpsSchedule; agents: AgentDirectory; environments: EnvironmentDirectory }>(({ props }) => () => {
    const { environmentId, agentId } = props.schedule.runsOn;
    if (!agentId) return <span data-runs-on data-platform>platform · no machine needed</span>;
    const agent = props.agents.lookup(agentId);
    const env = environmentId ? props.environments.lookup(environmentId) : null;
    return (
        <span data-runs-on>
            <AgentTile name={agent.name} hue={agent.hue} size={20} labelled />
            {environmentId
                ? <EnvironmentLine machine={env?.machineName ?? environmentId} runtime={env?.line.runtime ?? 'claude-code'} account={env?.line.account ?? ''} />
                : <EnvironmentLine machine="platform" runtime="anthropic-api" account="byo-key" />}
        </span>
    );
});

/** One entry: its own live read, so a firing or a switch re-renders this row alone. */
const ScheduleRow = component<{ ws: string; id: string; tz: string; agents: AgentDirectory; environments: EnvironmentDirectory; onError: (e: unknown) => void }>(({ props }) => {
    const defs = useActorDefs();
    const key = (): string => scheduleKeyOf(props.ws, props.id);
    const view = useActorState(defs.Schedule, () => [key(), 'get'] as const, { live: true });
    const st = signal({ busy: false, on: false });
    // The switch's own state, following the actor.
    const stopSync = effect(() => {
        const v = view.value;
        if (v) st.on = v.enabled;
    });
    onUnmounted(stopSync);
    const toggle = async (on: boolean): Promise<void> => {
        if (st.busy) return;
        st.busy = true;
        try {
            const client = actor(defs.Schedule, key());
            await (on ? client.enable() : client.disable());
        } catch (e) {
            // The actor did not change: the switch goes back to what it says.
            st.on = view.value?.enabled ?? !on;
            props.onError(e);
        } finally {
            st.busy = false;
        }
    };
    return (): JSXElement => {
        const v = view.value;
        // Indexed but never created (a create that failed halfway): nothing to show for it.
        if (!v) return <></>;
        const s = scheduleRow(v, props.tz, Date.now());
        const env = s.runsOn.environmentId ? props.environments.lookup(s.runsOn.environmentId) : null;
        const policy = env && !env.online ? `${env.machineName} is offline · policy: ${v.offlinePolicy === 'queue' ? 'queue until it returns' : v.offlinePolicy === 'fail' ? 'fail' : 'fall back to the platform runtime'}` : null;
        return (
            <tr data-scope="table" data-part="row" data-schedule={s.id} data-enabled={s.enabled ? '' : undefined}>
                <DataTable.Cell><Tag>{s.kind}</Tag></DataTable.Cell>
                <DataTable.Cell>
                    <span data-schedule-what>
                        <span data-schedule-title>{s.what}</span>
                        {policy ? <span data-policy-line>{policy}</span> : null}
                    </span>
                </DataTable.Cell>
                <DataTable.Cell><code data-mono data-dim>{s.when}</code></DataTable.Cell>
                <DataTable.Cell><code data-mono data-strong={s.enabled ? '' : undefined} data-next-run>{s.nextRun}</code></DataTable.Cell>
                <DataTable.Cell><RunsOn schedule={s} agents={props.agents} environments={props.environments} /></DataTable.Cell>
                <DataTable.Cell>
                    <Switch label={`Enable ${s.what}`} hideLabel model={() => st.on} disabled={st.busy} onCheckedChange={(on: boolean) => { void toggle(on); }} />
                </DataTable.Cell>
            </tr>
        );
    };
});

export const LiveSchedules = component(() => {
    useHead({ title: 'Schedules' });
    const defs = useActorDefs();
    const viewer = useViewer()();
    const agents = useAgentDirectory(defs, viewer);
    const environments = useEnvironmentDirectory(defs, viewer);
    const workdirs = useLiveWorkdirEnvironments(defs, viewer);
    // The "Project" option of an agent task (#333).
    const projects = useProjects(defs, viewer);
    const index = useActorState(defs.Workspace, () => viewer.workspaceId && ([workspaceKeyOf(viewer.workspaceId), 'get'] as const), { live: true });
    const st = signal({ busy: false, error: '' });
    const fail = (e: unknown): void => { st.error = e instanceof Error ? e.message : String(e); };
    const tz = (): string => index.value?.settings.timeZone ?? 'UTC';
    const create = async (input: NewScheduleInput): Promise<void> => {
        const ws = viewer.workspaceId;
        if (!ws || st.busy) return;
        st.busy = true;
        st.error = '';
        try {
            await createScheduleWith(defs, ws, input, tz());
            closeNewSchedule();
        } catch (e) {
            fail(e);
        } finally {
            st.busy = false;
        }
    };
    return () => {
        const ws = viewer.workspaceId;
        const ids = index.value?.schedules ?? [];
        const signedOut = !viewer.pending && !ws;
        return (
            <OpsPage page="schedules" title="Schedules">
                {signedOut
                    ? <EmptyState variant="generic" title="Sign in to see your schedules" caption="Schedules belong to your workspace." />
                    : ws && index.value && !ids.length
                        ? <EmptyState variant="generic" title="No schedules yet" caption="A reminder or a recurring agent task — New schedule creates one; the platform delivers it with every machine offline." />
                        : (
                            <DataTable
                                cols={SCHEDULES_COLS}
                                label="Schedules"
                                columns={[{ label: 'Kind' }, { label: 'What' }, { label: 'When' }, { label: 'Next run' }, { label: 'Runs on' }, { label: 'Enabled', hidden: true }]}
                                class="ag-schedules"
                            >
                                {ws ? ids.map((id) => <ScheduleRow ws={ws} id={id} tz={tz()} agents={agents} environments={environments} onError={fail} />) : null}
                            </DataTable>
                        )}
                {st.error ? <p data-chat-error role="alert">{st.error}</p> : null}
                <p data-foot-note>
                    <Icon name="schedules" size={14} />
                    <span>{dstRuleFor(tz())}</span>
                </p>
                <NewScheduleDialog
                    model={() => newScheduleRequest.open}
                    timeZone={tz()}
                    agents={agents.all().map((a) => ({ value: a.id, label: a.name }))}
                    environments={environments.all().map((e) => ({ value: e.id, label: e.label }))}
                    busy={st.busy}
                    workdirs={workdirs}
                    projects={projects.list().map((p) => ({ value: p.id, label: p.name }))}
                    machines={workdirs.machines().map((m) => ({ value: m.id, label: m.online ? m.name : `${m.name} (offline)` }))}
                    onCancel={closeNewSchedule}
                    onCreate={(input) => { void create(input); }}
                />
            </OpsPage>
        );
    };
});
