import { component } from 'sigx';
import { Link, useRoute } from '@sigx/router';
import { Alert, Button, Card, Timeline } from '@sigx/zero-daisyui/components';
import { Row } from '@agentic/ui';
import { Page } from '../components/Page';
import { StatusBadge } from '../components/StatusBadge';
import { agentById, machineById, sessionById, taskById } from '../mock/data';

/** `/sessions/:id` — one execution session; the transcript is a later issue. */
export const Session = component(() => {
    const route = useRoute();
    return () => {
        const session = sessionById(String(route.params.id));
        if (!session) {
            return (
                <Page title="Session not found">
                    <Alert color="warning"><Alert.Title>No session with id {String(route.params.id)}</Alert.Title></Alert>
                    <Link to="/">Back to the inbox</Link>
                </Page>
            );
        }
        const task = taskById(session.taskId);
        return (
            <Page title={`Session ${session.id}`} subtitle={`${agentById(session.agentId)?.name} on ${machineById(session.machineId)?.name}`}>
                <Row gap="sm" wrap>
                    <StatusBadge status={session.status} />
                    {task ? <Link to={`/tasks/${task.id}`}>{task.title}</Link> : null}
                    <small>{session.turns} turns · started {session.startedAt}</small>
                </Row>
                {session.status === 'interrupted' || session.status === 'error'
                    ? <Alert color="warning">
                        <Alert.Title>{session.status === 'error' ? 'Failed' : 'Interrupted'}</Alert.Title>
                        <Alert.Description>The turn was marked, never replayed. Resume issues a new prompt over the intact transcript.</Alert.Description>
                        <Button color="primary" size="sm">Resume</Button>
                    </Alert>
                    : null}
                <Card>
                    <Card.Header><Card.Title>Transcript (mock)</Card.Title></Card.Header>
                    <Card.Body>
                        <Timeline>
                            <Timeline.Item><Timeline.Marker /><Timeline.Content>Prompt received</Timeline.Content><Timeline.Connector /></Timeline.Item>
                            <Timeline.Item><Timeline.Marker /><Timeline.Content>Tool call: read files</Timeline.Content><Timeline.Connector /></Timeline.Item>
                            <Timeline.Item><Timeline.Marker /><Timeline.Content>Turn {session.turns}</Timeline.Content></Timeline.Item>
                        </Timeline>
                    </Card.Body>
                </Card>
            </Page>
        );
    };
});
