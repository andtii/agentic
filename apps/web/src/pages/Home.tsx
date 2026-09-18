import { component, signal, type JSXElement } from 'sigx';
import { Link } from '@sigx/router';
import { useActorState } from '@sigx/actors/app';
import { AgentTile, Button, ConfirmDialog, DataTable, EmptyState, EnvironmentLine, SectionHeading, StatusPill, WaitReasonLine } from '@agentic/ui';
import { useActorDefs, useViewer } from '../actors/defs';
import { workspaceKeyOf } from '../actors/keys';
import { Age } from '../components/Age';
import { Page } from '../components/Page';
import { Panel } from '../components/Panel';
import { defineTopbar } from '../components/topbar';
import { dataMode } from '../data-mode';
import { agentNamed, loadHome, rootOf, type MockTaskRow } from '../mock/workspace';
import { NeedsYou, useNeedsSource } from './inbox';
import { TASK_TABLE_COLS, TASK_TABLE_COLUMNS } from './task/live';
import { LiveActiveTasks } from './task/LiveTasks';
import { costPartsOf, costText, monthLabel } from './usage/live';
import { useMonthSpend } from './usage/LiveUsage';

/** The Home tasks table template (docs/design/HANDOFF.md → tables). */
export const HOME_TASK_COLS = TASK_TABLE_COLS;
export const TASK_COLUMNS = TASK_TABLE_COLUMNS;

/** One row of the active-tasks table — shared with `/tasks`. */
export const TaskRowCells = component<{ task: MockTaskRow }>(({ props }) => () => {
    const t = props.task;
    const agent = agentNamed(t.agentId);
    return (
        <>
            <DataTable.Cell>
                <span data-cell-status>
                    <StatusPill status={t.status} />
                </span>
            </DataTable.Cell>
            <DataTable.Cell>
                <span data-cell-objective>
                    <span data-cell-title title={t.objective}><Link to={`/tasks/${t.id}`}>{t.objective}</Link></span>
                    {t.wait ? <WaitReasonLine wait={t.wait} detail={t.waitDetail} /> : null}
                </span>
            </DataTable.Cell>
            <DataTable.Cell>
                <span data-cell-agent>
                    <AgentTile name={agent.name} hue={agent.hue} size={22} />
                    <span>{agent.name}</span>
                </span>
            </DataTable.Cell>
            <DataTable.Cell><EnvironmentLine tone={t.status === 'queued' ? 'dim' : 'muted'} {...t.environment} /></DataTable.Cell>
            <DataTable.Cell><span data-align="end"><Age at={t.createdAt} /></span></DataTable.Cell>
        </>
    );
});

defineTopbar('home', () => ({ actions: () => <Button intent="primary" icon="plus">New chat</Button> }));

/**
 * `/` on the platform (#146): "Needs you" as before (#40), the Workspace's
 * time zone and agent count (the empty state until the first agent), this
 * month's spend from the Ledger — the reported and estimated parts kept
 * apart, `n/a` when nothing was priced — and the active tasks from the
 * TaskIndex (`LiveActiveTasks`). Today's schedule is not read here yet: the
 * Schedules page lists it.
 */
export const LiveHome = component(() => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const needs = useNeedsSource()();
    const ws = useActorState(defs.Workspace, () => viewer.workspaceId && ([workspaceKeyOf(viewer.workspaceId), 'get'] as const), { live: true });
    const spend = useMonthSpend(defs, viewer);
    return (): JSXElement => {
        const w = ws.value;
        if (w && w.agents.length === 0) {
            return (
                <Page title="Home" page="home" hideTitle>
                    <EmptyState variant="workspace" />
                </Page>
            );
        }
        const total = spend.summary?.total ?? null;
        const parts = total ? costPartsOf(total) : null;
        return (
            <Page title="Home" page="home" hideTitle>
                <NeedsYou source={needs} />

                <aside data-home-rail aria-label="Today and spend">
                    <Panel label={`Today · ${w?.settings.timeZone ?? 'UTC'}`} slots={{ aside: () => <Link to="/schedules">All schedules</Link> }}>
                        <ul data-today>
                            <li data-today-empty><span data-today-title>Today's schedule is listed on the Schedules page.</span></li>
                        </ul>
                        <p data-panel-note>Reminders are delivered by the platform, even with every machine offline.</p>
                    </Panel>
                    <Panel label="This month" slots={{ aside: () => <Link to="/usage">Usage</Link> }}>
                        <p data-spend data-quality={total?.quality ?? 'not-reported'} aria-busy={spend.loading ? 'true' : undefined}>
                            <strong data-spend-value data-dim={parts ? undefined : ''}>{parts ? costText(parts) : 'n/a'}</strong>
                            <span data-spend-limit>{monthLabel(spend.month)} · no monthly limit set</span>
                        </p>
                        <p data-panel-note>
                            {!total || total.rows === 0
                                ? 'Nothing recorded yet. Each turn a session runs adds a row to the ledger.'
                                : parts
                                    ? (parts.estimated > 0 ? `~ marks the ${costText({ reported: 0, estimated: parts.estimated })} priced at a guessed rate; ${total.unpricedRows} ${total.unpricedRows === 1 ? 'turn' : 'turns'} reported no cost.` : `Every priced turn was reported by its provider; ${total.unpricedRows} ${total.unpricedRows === 1 ? 'turn' : 'turns'} reported no cost.`)
                                    : `${total.rows} ${total.rows === 1 ? 'turn' : 'turns'} recorded, none with a cost — the runtime gives no cost data.`}
                        </p>
                    </Panel>
                </aside>

                <LiveActiveTasks />
            </Page>
        );
    };
});

/** `/` — what needs you (live through `useNeedsSource`, #40), today and spend, every active task; the platform's in live mode (#146). */
export const Home = component(() => {
    if (dataMode() === 'live') return () => <LiveHome />;
    const view = loadHome();
    const needs = useNeedsSource()();
    const st = signal({ stopAll: false });
    const chains = () => [...new Set(view.tasks.map((t) => rootOf(t).objective))];
    return () => {
        if (view.empty) {
            return (
                <Page title="Home" page="home" hideTitle>
                    <EmptyState variant="workspace" />
                </Page>
            );
        }
        const spendPct = Math.min(100, Math.round((view.spend.monthUsd / view.spend.limitUsd) * 100));
        return (
            <Page title="Home" page="home" hideTitle>
                <NeedsYou source={needs} />

                <aside data-home-rail aria-label="Today and spend">
                    <Panel label={`Today · ${view.timeZone}`} slots={{ aside: () => <Link to="/schedules">All schedules</Link> }}>
                        <ul data-today>
                            {view.today.map((entry) => {
                                const agent = entry.agentId ? agentNamed(entry.agentId) : undefined;
                                return (
                                    <li>
                                        <span data-today-time>{entry.time}</span>
                                        <span data-today-title>{entry.title}</span>
                                        {agent ? <AgentTile name={agent.name} hue={agent.hue} size={20} /> : null}
                                    </li>
                                );
                            })}
                        </ul>
                        <p data-panel-note>Reminders are delivered by the platform, even with every machine offline.</p>
                    </Panel>
                    <Panel label="This month" slots={{ aside: () => <Link to="/usage">Usage</Link> }}>
                        <p data-spend>
                            <strong data-spend-value>${view.spend.monthUsd.toFixed(2)}</strong>
                            <span data-spend-limit>of ${view.spend.limitUsd.toFixed(2)} limit</span>
                        </p>
                        <div data-spend-bar role="progressbar" aria-label="Month spend against the limit" aria-valuenow={spendPct} aria-valuemin={0} aria-valuemax={100}>
                            <span style={`inline-size: ${spendPct}%`} />
                        </div>
                        <p data-panel-note>{view.spend.note}</p>
                    </Panel>
                </aside>

                <section data-home-tasks aria-label="Active tasks">
                    <SectionHeading slots={{ aside: () => <Button intent="danger" icon="stop" onClick={() => { st.stopAll = true; }}>Stop all</Button> }}>Active tasks</SectionHeading>
                    <DataTable cols={HOME_TASK_COLS} columns={TASK_COLUMNS} label="Active tasks">
                        {view.tasks.map((task) => (
                            <DataTable.Row>
                                <TaskRowCells task={task} />
                            </DataTable.Row>
                        ))}
                    </DataTable>
                    <ConfirmDialog
                        model={() => st.stopAll}
                        title="Stop every active task?"
                        description="Each chain stops at the next safe point. Children that do not acknowledge are listed as could not be stopped."
                        dependents={chains()}
                        dependentsLabel={`Stops ${chains().length} ${chains().length === 1 ? 'chain' : 'chains'}`}
                        confirmLabel={`Stop ${chains().length} ${chains().length === 1 ? 'chain' : 'chains'}`}
                        onConfirm={() => { st.stopAll = false; }}
                    />
                </section>
            </Page>
        );
    };
});
