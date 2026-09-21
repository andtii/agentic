/**
 * `/tasks` on the platform and Home's active-tasks table (#146): the
 * workspace's TaskIndex read live (`list()`, one record — every Task actor
 * writes its row over a hop on create and every status or wait change),
 * each row's assignee through the chat directory, rendered with the same
 * columns and `data-*` anatomy the mock pages draw. A row links to the
 * task's tree; a waiting row carries its wait reason. "Stop all" on Home
 * is `Task.cancel('user')` per chain root (the cascade stops the subtree).
 */
import { component, signal, useHead, type JSXElement } from 'sigx';
import { Link } from '@sigx/router';
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
import { AgentTile, Button, ConfirmDialog, DataTable, EmptyState, EnvironmentLine, SectionHeading, StatusPill, WaitReasonLine } from '@agentic/ui';
import { Age } from '../../components/Age';
import { Page } from '../../components/Page';
import { useActorDefs, useViewer, type ActorDefs, type ViewerState } from '../../actors/defs';
import { taskIndexKeyOf, taskKeyOf } from '../../actors/keys';
import { useAgentDirectory, type AgentDirectory } from '../chat/directory';
import { useEnvironmentDirectory } from '../ops/environments';
import { chainRoots, countTasks, filterTasks, isActiveRow, TASK_FILTERS, TASK_TABLE_COLS, TASK_TABLE_COLUMNS, taskListRow, type TaskFilter, type TaskListRow } from './live';
import { LiveStartTask } from './LiveStartTask';

export interface TaskRows {
    /** Every task the index holds, newest first, assignees resolved. */
    all(): TaskListRow[];
    readonly loading: boolean;
    readonly error: Error | null;
}

/** Called in a component's setup: the index as a live read, joined with the directory at render. */
export function useTaskRows(defs: ActorDefs, viewer: ViewerState, directory: AgentDirectory): TaskRows {
    const index = useActorState(defs.TaskIndex, () => viewer.workspaceId && ([taskIndexKeyOf(viewer.workspaceId), 'list'] as const), { live: true });
    // A row waiting on its machine (#366) names it in the wait column.
    const machines = useEnvironmentDirectory(defs, viewer);
    const machineName = (id: string): string | undefined => machines.machines().find((m) => m.id === id)?.name;
    return {
        all: () => (index.value ?? []).map((row) => taskListRow(row, directory.lookup, machineName)),
        get loading() {
            return index.loading || directory.loading;
        },
        get error() {
            return index.error ?? directory.error;
        }
    };
}

/** One row of the tasks table, the mock `TaskRowCells` anatomy over a live row. */
export const LiveTaskRowCells = component<{ task: TaskListRow; now: number }>(({ props }) => () => {
    const t = props.task;
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
                    <AgentTile name={t.agent.name} hue={t.agent.hue} size={22} />
                    <span>{t.agent.name}</span>
                </span>
            </DataTable.Cell>
            <DataTable.Cell><EnvironmentLine tone={t.status === 'queued' ? 'dim' : 'muted'} {...t.environment} /></DataTable.Cell>
            <DataTable.Cell><span data-align="end"><Age at={t.createdAt} now={props.now} /></span></DataTable.Cell>
        </>
    );
});

/** Cancel every chain root among `rows` as the user; rejects with the first failure after trying them all. */
export async function stopAll(defs: ActorDefs, ws: string, rows: readonly TaskListRow[]): Promise<void> {
    const results = await Promise.allSettled(chainRoots(rows).map((r) => actor(defs.TaskActor, taskKeyOf(ws, r.id)).cancel('user')));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason));
}

/**
 * Home's "Active tasks" section over the live index: the table of every
 * unsettled task and the Stop-all dialog listing the chains it stops.
 */
export const LiveActiveTasks = component(() => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const directory = useAgentDirectory(defs, viewer);
    const tasks = useTaskRows(defs, viewer, directory);
    const st = signal({ stopAll: false, busy: false, error: '' });
    const stop = async (rows: readonly TaskListRow[]): Promise<void> => {
        const ws = viewer.workspaceId;
        st.stopAll = false;
        if (!ws || st.busy) return;
        st.busy = true;
        st.error = '';
        try {
            await stopAll(defs, ws, rows);
        } catch (e) {
            st.error = e instanceof Error ? e.message : String(e);
        } finally {
            st.busy = false;
        }
    };
    return (): JSXElement => {
        const rows = tasks.all().filter(isActiveRow);
        const chains = chainRoots(rows);
        const now = Date.now();
        return (
            <section data-home-tasks aria-label="Active tasks" aria-busy={tasks.loading ? 'true' : undefined}>
                <SectionHeading count={rows.length ? `${rows.length} active` : undefined} slots={{ aside: () => <Button intent="danger" icon="stop" disabled={!chains.length || st.busy} onClick={() => { st.stopAll = true; }}>Stop all</Button> }}>Active tasks</SectionHeading>
                {rows.length
                    ? (
                        <DataTable cols={TASK_TABLE_COLS} columns={TASK_TABLE_COLUMNS} label="Active tasks">
                            {rows.map((task) => (
                                <DataTable.Row>
                                    <LiveTaskRowCells task={task} now={now} />
                                </DataTable.Row>
                            ))}
                        </DataTable>
                    )
                    : tasks.loading
                        ? <p data-panel-note aria-busy="true">Loading tasks…</p>
                        : <EmptyState variant="generic" caption="No active tasks. Post in a chat to start one." slots={{ actions: () => <Link to="/tasks">All tasks</Link> }} />}
                {st.error ? <p data-chat-error role="alert">{st.error}</p> : null}
                <ConfirmDialog
                    model={() => st.stopAll}
                    title="Stop every active task?"
                    description="Each chain stops at the next safe point. Children that do not acknowledge are listed as could not be stopped."
                    dependents={chains.map((c) => c.objective)}
                    dependentsLabel={`Stops ${chains.length} ${chains.length === 1 ? 'chain' : 'chains'}`}
                    confirmLabel={`Stop ${chains.length} ${chains.length === 1 ? 'chain' : 'chains'}`}
                    onConfirm={() => { void stop(rows); }}
                />
            </section>
        );
    };
});

/** `/tasks` on the platform: every task the index holds, the Home table at full width with filter chips by status. */
export const LiveTasks = component(() => {
    useHead({ title: 'Tasks' });
    const defs = useActorDefs();
    const viewer = useViewer()();
    const directory = useAgentDirectory(defs, viewer);
    const tasks = useTaskRows(defs, viewer, directory);
    const st = signal({ filter: 'all' as TaskFilter });
    return (): JSXElement => {
        const all = tasks.all();
        const rows = filterTasks(all, st.filter);
        const counts = countTasks(all);
        const signedOut = !viewer.pending && !viewer.workspaceId;
        const now = Date.now();
        return (
            <Page title="Tasks" page="tasks" hideTitle>
                <SectionHeading count={`${all.length} total`}>Tasks</SectionHeading>
                <div data-filter-chips role="group" aria-label="Filter by status">
                    {TASK_FILTERS.map((f) => (
                        <button type="button" data-chip aria-pressed={st.filter === f.value ? 'true' : 'false'} onClick={() => { st.filter = f.value; }}>
                            {f.label} <span data-chip-count>{counts[f.value]}</span>
                        </button>
                    ))}
                </div>
                {signedOut
                    ? <EmptyState variant="generic" title="Sign in to see your tasks" caption="Tasks belong to your workspace." />
                    : rows.length
                        ? (
                            <DataTable cols={TASK_TABLE_COLS} columns={TASK_TABLE_COLUMNS} label="Tasks">
                                {rows.map((task) => (
                                    <DataTable.Row>
                                        <LiveTaskRowCells task={task} now={now} />
                                    </DataTable.Row>
                                ))}
                            </DataTable>
                        )
                        : tasks.loading
                            ? <p data-panel-note aria-busy="true">Loading tasks…</p>
                            : <EmptyState variant="generic" caption={st.filter === 'all' ? 'No tasks yet. Post in a chat to start one.' : `No ${st.filter} tasks.`} />}
                {tasks.error ? <p data-chat-error role="alert">{tasks.error.message}</p> : null}
                <LiveStartTask />
            </Page>
        );
    };
});
