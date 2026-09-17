import { component, signal } from 'sigx';
import type { TaskStatus } from '@agentic/core';
import { DataTable, EmptyState, SectionHeading } from '@agentic/ui';
import { Page } from '../components/Page';
import { loadTasks } from '../mock/workspace';
import { HOME_TASK_COLS, TASK_COLUMNS, TaskRowCells } from './Home';

const FILTERS: readonly { readonly value: TaskStatus | 'all'; readonly label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'waiting', label: 'Waiting' },
    { value: 'active', label: 'Active' },
    { value: 'queued', label: 'Queued' },
    { value: 'completed', label: 'Completed' },
    { value: 'failed', label: 'Failed' },
    { value: 'cancelled', label: 'Cancelled' }
];

/** `/tasks` — every task, the Home table at full width with filter chips by status. */
export const Tasks = component(() => {
    const all = loadTasks();
    const st = signal({ filter: 'all' as TaskStatus | 'all' });
    return () => {
        const rows = st.filter === 'all' ? all : all.filter((t) => t.status === st.filter);
        const count = (value: TaskStatus | 'all') => (value === 'all' ? all.length : all.filter((t) => t.status === value).length);
        return (
            <Page title="Tasks" page="tasks" hideTitle>
                <SectionHeading count={`${all.length} total`}>Tasks</SectionHeading>
                <div data-filter-chips role="group" aria-label="Filter by status">
                    {FILTERS.map((f) => (
                        <button type="button" data-chip aria-pressed={st.filter === f.value ? 'true' : 'false'} onClick={() => { st.filter = f.value; }}>
                            {f.label} <span data-chip-count>{count(f.value)}</span>
                        </button>
                    ))}
                </div>
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
                    : <EmptyState variant="generic" caption={`No ${st.filter} tasks.`} />}
            </Page>
        );
    };
});
