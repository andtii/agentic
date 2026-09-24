import { component, signal, type Define } from 'sigx';
import { AgentTile, Button, DataTable, EnvironmentLine, Icon, Switch, Tag } from '@agentic/ui';
import { dstRule, offlinePolicyLine, opsAgent, opsEnvironment, opsMachine, opsSchedules, type OpsSchedule } from '../mock/ops';
import { OpsPage } from './ops/OpsPage';
import { defineTopbar } from '../components/topbar';
import { dataMode } from '../data-mode';
import { openNewSchedule } from './ops/head';
import { SCHEDULES_COLS } from './ops/live';
import { LiveSchedules } from './ops/LiveSchedules';

/** The artboard's column template (`docs/design/HANDOFF.md` → tables). */
export { SCHEDULES_COLS };

export type SchedulesViewProps = Define.Prop<'schedules', readonly OpsSchedule[], true> & Define.Prop<'dstRule', string, true>;

/** Where a schedule runs: the platform needs no machine; an agent task names its tile and environment line. */
const RunsOn = component<Define.Prop<'schedule', OpsSchedule, true>>(({ props }) => () => {
    const { environmentId, agentId } = props.schedule.runsOn;
    const agent = agentId ? opsAgent(agentId) : undefined;
    if (!agent) return <span data-runs-on data-platform>platform · no machine needed</span>;
    const env = environmentId ? opsEnvironment(environmentId) : undefined;
    const machine = env ? opsMachine(env.machineId) : undefined;
    const envName = env?.name;
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
// The button opens the live page's dialog (#145); the mock page mounts none, so there it stays the artboard's inert control.
defineTopbar('schedules', () => ({ actions: () => <Button intent="primary" icon="plus" onClick={dataMode() === 'live' ? openNewSchedule : undefined}>New schedule</Button> }));

export const SchedulesView = component<SchedulesViewProps>(({ props }) => {
    const enabled = signal<Record<string, boolean>>(Object.fromEntries(props.schedules.map(s => [s.id, s.enabled])));
    return () => (
        <OpsPage page="schedules" title="Schedules">
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
                        <DataTable.Row data-schedule={s.id}>
                            <DataTable.Cell column={0}><Tag>{s.kind}</Tag></DataTable.Cell>
                            <DataTable.Cell column={1}>
                                <span data-schedule-what>
                                    <span data-schedule-title>{s.what}</span>
                                    {policy ? <span data-policy-line>{policy}</span> : null}
                                </span>
                            </DataTable.Cell>
                            <DataTable.Cell column={2}><code data-mono data-dim>{s.when}</code></DataTable.Cell>
                            <DataTable.Cell column={3}><code data-mono data-strong={on ? '' : undefined}>{on ? s.nextRun : 'paused'}</code></DataTable.Cell>
                            <DataTable.Cell column={4}><RunsOn schedule={s} /></DataTable.Cell>
                            <DataTable.Cell column={5}>
                                <Switch label={`Enable ${s.what}`} hideLabel model={() => enabled[s.id]} onCheckedChange={(v: boolean) => { enabled[s.id] = v; }} />
                            </DataTable.Cell>
                        </DataTable.Row>
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

/** `/schedules`: the workspace's entries on the platform (`LiveSchedules`, #145), or the mock table. */
export const Schedules = component(() => () => (dataMode() === 'live' ? <LiveSchedules /> : <SchedulesView schedules={opsSchedules} dstRule={dstRule} />));
