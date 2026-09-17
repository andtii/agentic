import { component } from 'sigx';
import { Link, useRoute } from '@sigx/router';
import { Alert, Card, Status } from '@sigx/zero-daisyui/components';
import { Row, Stack } from '@agentic/ui';
import { Page } from '../components/Page';
import { StatusBadge } from '../components/StatusBadge';
import { machineById, sessions } from '../mock/data';

/** `/machines/:id` — one machine, its runtimes and sessions. */
export const Machine = component(() => {
    const route = useRoute();
    return () => {
        const m = machineById(String(route.params.id));
        if (!m) {
            return (
                <Page title="Machine not found">
                    <Alert color="warning"><Alert.Title>No machine with id {String(route.params.id)}</Alert.Title></Alert>
                    <Link to="/machines">All machines</Link>
                </Page>
            );
        }
        const own = sessions.filter(s => s.machineId === m.id);
        return (
            <Page title={m.name} subtitle={m.os}>
                <Row gap="sm">
                    <Status color={m.online ? 'success' : 'neutral'} label={m.online ? 'online' : 'offline'} />
                    <span>{m.online ? 'online' : `offline since ${m.lastSeen}`}</span>
                </Row>
                <Card>
                    <Card.Header><Card.Title>Runtimes</Card.Title></Card.Header>
                    <Card.Body><Stack as="ul" gap="2xs">{m.runtimes.map(r => <li><code>{r}</code></li>)}</Stack></Card.Body>
                </Card>
                <Card>
                    <Card.Header><Card.Title>Sessions</Card.Title></Card.Header>
                    <Card.Body>
                        <Stack as="ul" gap="xs">
                            {own.map(s => (
                                <Row as="li" gap="sm">
                                    <StatusBadge status={s.status} />
                                    <Link to={`/sessions/${s.id}`}>{s.id}</Link>
                                </Row>
                            ))}
                        </Stack>
                    </Card.Body>
                </Card>
            </Page>
        );
    };
});
