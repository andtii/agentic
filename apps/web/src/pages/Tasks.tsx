import { component, signal } from 'sigx';
import type { TaskStatus } from '@agentic/core';
import { Button, DataTable, EmptyState, FilterChips, SectionHeading } from '@agentic/ui';
import { defineTopbar } from '../components/topbar';
import { openStartTask } from './task/start';
import { Page } from '../components/Page';
import { dataMode } from '../data-mode';
import { loadTasks } from '../mock/workspace';
import { HOME_TASK_COLS, TASK_COLUMNS, TaskRowCells } from './Home';
import { LiveTasks } from './task/LiveTasks';

const FILTERS: readonly { readonly value: TaskStatus | 'all'; readonly label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'waiting', label: 'Waiting' },
    { value: 'active', label: 'Active' },
    { value: 'queued', label: 'Queued' },
    { value: 'completed', label: 'Completed' },
    { value: 'failed', label: 'Failed' },
    { value: 'cancelled', label: 'Cancelled' }
];

/** `/tasks` — every task, the Home table at full width with filter chips by status; the TaskIndex in live mode (#146). */
/** "Start task" (#193): live only — the mock workspace has no router to hand a task to, so there it is disabled. */
defineTopbar('tasks', () => ({ actions: () => <Button intent="primary" icon="plus" disabled={dataMode() !== 'live'} onClick={() => openStartTask()}>Start task</Button> }));

export const Tasks = component(() => {
    const all = loadTasks();
    const st = signal({ filter: 'all' as TaskStatus | 'all' });
    return () => {
        if (dataMode() === 'live') return <LiveTasks />;
        const rows = st.filter === 'all' ? all : all.filter((t) => t.status === st.filter);
        const count = (value: TaskStatus | 'all') => (value === 'all' ? all.length : all.filter((t) => t.status === value).length);
        return (
            <Page title="Tasks" page="tasks" hideTitle>
                <SectionHeading count={`${all.length} total`}>Tasks</SectionHeading>
                <FilterChips
                    label="Filter by status"
                    model={() => st.filter}
                    options={FILTERS.map((f) => ({ value: f.value, label: f.label, count: count(f.value) }))}
                    onValueChange={(v: string) => { st.filter = v as TaskStatus | 'all'; }}
                />
                {rows.length
                    ? (
                        <DataTable cols={HOME_TASK_COLS} columns={TASK_COLUMNS} label="Tasks">
                            {rows.map((task) => (
                                <DataTable.Row>
                                    <TaskRowCells task={task} />
                                </DataTable.Row>
                            ))}
                        </DataTable>
                    )
                    : <EmptyState variant="generic" caption={st.filter === 'all' ? 'No tasks yet.' : `No ${st.filter} tasks.`} />}
            </Page>
        );
    };
});
