import { component } from 'sigx';
import { Link, useRoute } from '@sigx/router';
import { Alert, Card } from '@sigx/zero-daisyui/components';
import { Row, Stack } from '@agentic/ui';
import { Page } from '../components/Page';
import { StatusBadge } from '../components/StatusBadge';
import { agentById, sessions, taskById, type MockTask } from '../mock/data';

function TaskTree(props: { task: MockTask }) {
    const t = props.task;
    return (
        <Stack as="li" gap="xs">
            <Row gap="sm" wrap>
                <StatusBadge status={t.status} />
                <Link to={`/tasks/${t.id}`}>{t.title}</Link>
                <small>{agentById(t.agentId)?.name} · ${t.costUsd.toFixed(2)}</small>
            </Row>
            {t.children?.length
                ? <Stack as="ul" gap="xs" pad="md">{t.children.map(c => <TaskTree task={c} />)}</Stack>
                : null}
        </Stack>
    );
}

/** `/tasks/:id` — the task and its delegation tree. */
export const Task = component(() => {
    const route = useRoute();
    return () => {
        const task = taskById(String(route.params.id));
        if (!task) {
            return (
                <Page title="Task not found">
                    <Alert color="warning"><Alert.Title>No task with id {String(route.params.id)}</Alert.Title></Alert>
                    <Link to="/">Back to the inbox</Link>
                </Page>
            );
        }
        const own = sessions.filter(s => s.taskId === task.id);
        return (
            <Page title={task.title} subtitle={`${agentById(task.agentId)?.name} · $${task.costUsd.toFixed(2)}`}>
                <Card>
                    <Card.Header><Card.Title>Tree</Card.Title></Card.Header>
                    <Card.Body>
                        <Stack as="ul" gap="sm"><TaskTree task={task} /></Stack>
                    </Card.Body>
                </Card>
                <Card>
                    <Card.Header><Card.Title>Sessions</Card.Title></Card.Header>
                    <Card.Body>
                        {own.length
                            ? <Stack as="ul" gap="xs">{own.map(s => <li><Link to={`/sessions/${s.id}`}>{s.id}</Link> — {s.status}</li>)}</Stack>
                            : <p>No sessions for this task.</p>}
                    </Card.Body>
                </Card>
            </Page>
        );
    };
});
