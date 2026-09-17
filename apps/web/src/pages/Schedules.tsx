import { component, signal, type Define } from 'sigx';
import { AgentTile, Button, DataTable, EnvironmentLine, Icon, Switch, Tag } from '@agentic/ui';
import { dstRule, offlinePolicyLine, opsAgent, opsMachine, opsSchedules, type OpsSchedule } from '../mock/ops';
import { OpsPage } from './ops/OpsPage';

/** The artboard's column template (`docs/design/HANDOFF.md` → tables). */
export const SCHEDULES_COLS = '110px 1fr 140px 140px 310px 44px';

export type SchedulesViewProps = Define.Prop<'schedules', readonly OpsSchedule[], true> & Define.Prop<'dstRule', string, true>;

/** Where a schedule runs: the platform needs no machine; an agent task names its tile and environment line. */
const RunsOn = component<Define.Prop<'schedule', OpsSchedule, true>>(({ props }) => () => {
    const { environmentId, agentId } = props.schedule.runsOn;
    const agent = agentId ? opsAgent(agentId) : undefined;
    if (!agent) return <span data-runs-on data-platform>platform · no machine needed</span>;
    const [machineId, envName] = environmentId ? environmentId.split(':') : [undefined, undefined];
    const machine = machineId ? opsMachine(machineId) : undefined;
    return (
        <span data-runs-on>
            <AgentTile name={agent.name} hue={agent.hue} size={20} labelled />
            {machine && envName
                ? <EnvironmentLine machine={machine.name} runtime="claude-code" account={envName} />
                : <EnvironmentLine machine="platform" runtime="anthropic-api" account="byo-key" />}
        </span>
    );
});

/**
 * `/schedules` — kind tag, what, when, next run, runs on, enable switch;
 * a schedule bound to an offline environment shows the amber policy line
 * under its name, and the footer states the DST rule (AST-07).
 */
export const SchedulesView = component<SchedulesViewProps>(({ props }) => {
    const enabled = signal<Record<string, boolean>>(Object.fromEntries(props.schedules.map(s => [s.id, s.enabled])));
    return () => (
        <OpsPage page="schedules" title="Schedules" slots={{ actions: () => <Button intent="primary" icon="plus">New schedule</Button> }}>
            <DataTable
                cols={SCHEDULES_COLS}
                label="Schedules"
                columns={[{ label: 'Kind' }, { label: 'What' }, { label: 'When' }, { label: 'Next run' }, { label: 'Runs on' }, { label: 'Enabled', hidden: true }]}
                class="ag-schedules"
            >
                {props.schedules.map(s => {
                    const policy = offlinePolicyLine(s);
                    const on = enabled[s.id] ?? s.enabled;
                    return (
                        <tr data-scope="table" data-part="row" data-schedule={s.id}>
                            <DataTable.Cell><Tag>{s.kind}</Tag></DataTable.Cell>
                            <DataTable.Cell>
                                <span data-schedule-what>
                                    <span data-schedule-title>{s.what}</span>
                                    {policy ? <span data-policy-line>{policy}</span> : null}
                                </span>
                            </DataTable.Cell>
                            <DataTable.Cell><code data-mono data-dim>{s.when}</code></DataTable.Cell>
                            <DataTable.Cell><code data-mono data-strong={on ? '' : undefined}>{on ? s.nextRun : 'paused'}</code></DataTable.Cell>
                            <DataTable.Cell><RunsOn schedule={s} /></DataTable.Cell>
                            <DataTable.Cell>
                                <Switch label={`Enable ${s.what}`} hideLabel model={() => enabled[s.id]} onCheckedChange={(v: boolean) => { enabled[s.id] = v; }} />
                            </DataTable.Cell>
                        </tr>
                    );
                })}
            </DataTable>
            <p data-foot-note>
                <Icon name="schedules" size={14} />
                <span>{props.dstRule}</span>
            </p>
        </OpsPage>
    );
});

export const Schedules = component(() => () => <SchedulesView schedules={opsSchedules} dstRule={dstRule} />);
