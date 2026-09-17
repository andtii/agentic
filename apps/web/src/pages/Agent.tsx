import { component } from 'sigx';
import { Link, useRoute } from '@sigx/router';
import { Alert, Card, Tabs } from '@sigx/zero-daisyui/components';
import { Row, Stack } from '@agentic/ui';
import { Page } from '../components/Page';
import { StatusBadge } from '../components/StatusBadge';
import { agentById, sessions, tasks } from '../mock/data';

/** `/agents/:id` — overview, config + versions, memory, sessions. */
export const Agent = component(() => {
    const route = useRoute();
    return () => {
        const agent = agentById(String(route.params.id));
        if (!agent) {
            return (
                <Page title="Agent not found">
                    <Alert color="warning"><Alert.Title>No agent with id {String(route.params.id)}</Alert.Title></Alert>
                    <Link to="/agents">All agents</Link>
                </Page>
            );
        }
        const own = sessions.filter(s => s.agentId === agent.id);
        return (
            <Page title={agent.name} subtitle={agent.description}>
                <Row gap="sm">
                    <StatusBadge status={agent.status} />
                    <code>{agent.runtime}</code>
                    <span>config v{agent.configVersion}</span>
                </Row>
                <Tabs defaultValue="overview">
                    <Tabs.List>
                        <Tabs.Tab value="overview">Overview</Tabs.Tab>
                        <Tabs.Tab value="config">Config</Tabs.Tab>
                        <Tabs.Tab value="memory">Memory</Tabs.Tab>
                        <Tabs.Tab value="sessions">Sessions</Tabs.Tab>
                    </Tabs.List>
                    <Tabs.Panel value="overview">
                        <Card>
                            <Card.Body>
                                <Stack gap="xs">
                                    <span>{tasks.filter(t => t.agentId === agent.id).length} tasks, {own.length} sessions</span>
                                    <small>Mock data — the real overview reads the Agent actor.</small>
                                </Stack>
                            </Card.Body>
                        </Card>
                    </Tabs.Panel>
                    <Tabs.Panel value="config">
                        <Card>
                            <Card.Body>
                                <p>Versions 1 … {agent.configVersion}. Instructions, skills, tools and permissions live here.</p>
                            </Card.Body>
                        </Card>
                    </Tabs.Panel>
                    <Tabs.Panel value="memory">
                        <Card><Card.Body><p>No memories yet (mock).</p></Card.Body></Card>
                    </Tabs.Panel>
                    <Tabs.Panel value="sessions">
                        <Stack as="ul" gap="xs">
                            {own.map(s => (
                                <Row as="li" gap="sm">
                                    <StatusBadge status={s.status} />
                                    <Link to={`/sessions/${s.id}`}>{s.id}</Link>
                                    <small>{s.turns} turns · {s.startedAt}</small>
                                </Row>
                            ))}
                        </Stack>
                    </Tabs.Panel>
                </Tabs>
            </Page>
        );
    };
});
