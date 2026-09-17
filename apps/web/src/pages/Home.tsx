import { component } from 'sigx';
import { Link } from '@sigx/router';
import { Card, Stats, Table } from '@sigx/zero-daisyui/components';
import { Col, Row, Stack } from '@agentic/ui';
import { Page } from '../components/Page';
import { StatusBadge } from '../components/StatusBadge';
import { agentById, agents, chats, inbox, machines, tasks } from '../mock/data';

/** `/` — inbox + active tasks. */
export const Home = component(() => {
    const active = tasks.filter(t => t.status === 'running' || t.status === 'blocked');
    return () => (
        <Page title="Inbox" subtitle="What needs you, and what is running.">
            <Stats>
                <Stats.Item>
                    <Stats.Title>Agents</Stats.Title>
                    <Stats.Value>{agents.length}</Stats.Value>
                    <Stats.Desc>{agents.filter(a => a.status === 'busy').length} busy</Stats.Desc>
                </Stats.Item>
                <Stats.Item>
                    <Stats.Title>Active tasks</Stats.Title>
                    <Stats.Value>{active.length}</Stats.Value>
                    <Stats.Desc>{tasks.filter(t => t.status === 'failed').length} failed</Stats.Desc>
                </Stats.Item>
                <Stats.Item>
                    <Stats.Title>Machines online</Stats.Title>
                    <Stats.Value>{machines.filter(m => m.online).length}</Stats.Value>
                    <Stats.Desc>of {machines.length}</Stats.Desc>
                </Stats.Item>
            </Stats>

            <Row gap="xl" align="start" wrap>
                <Col grow><Card>
                    <Card.Header><Card.Title>Needs you</Card.Title></Card.Header>
                    <Card.Body>
                        <Stack as="ul" gap="sm">
                            {inbox.map(item => (
                                <Row as="li" gap="sm">
                                    <StatusBadge status={item.kind} />
                                    <Link to={item.href}>{item.title}</Link>
                                </Row>
                            ))}
                        </Stack>
                    </Card.Body>
                </Card></Col>
                <Col grow><Card>
                    <Card.Header><Card.Title>Recent chats</Card.Title></Card.Header>
                    <Card.Body>
                        <Stack as="ul" gap="sm">
                            {chats.map(chat => (
                                <Stack as="li" gap="2xs">
                                    <Link to={`/chats/${chat.id}`}>{chat.title}</Link>
                                    <small>{agentById(chat.agentId)?.name} · {chat.preview}</small>
                                </Stack>
                            ))}
                        </Stack>
                    </Card.Body>
                </Card></Col>
            </Row>

            <Table>
                <Table.Caption>Active tasks</Table.Caption>
                <Table.Head>
                    <Table.Row>
                        <Table.HeaderCell>Task</Table.HeaderCell>
                        <Table.HeaderCell>Agent</Table.HeaderCell>
                        <Table.HeaderCell>Status</Table.HeaderCell>
                        <Table.HeaderCell>Cost</Table.HeaderCell>
                    </Table.Row>
                </Table.Head>
                <Table.Body>
                    {active.map(task => (
                        <Table.Row>
                            <Table.Cell><Link to={`/tasks/${task.id}`}>{task.title}</Link></Table.Cell>
                            <Table.Cell>{agentById(task.agentId)?.name}</Table.Cell>
                            <Table.Cell><StatusBadge status={task.status} /></Table.Cell>
                            <Table.Cell>${task.costUsd.toFixed(2)}</Table.Cell>
                        </Table.Row>
                    ))}
                </Table.Body>
            </Table>
        </Page>
    );
});
