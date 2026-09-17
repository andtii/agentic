import { component } from 'sigx';
import { Link } from '@sigx/router';
import { Status, Table } from '@sigx/zero-daisyui/components';
import { Row } from '@agentic/ui';
import { Page } from '../components/Page';
import { machines } from '../mock/data';

/** `/machines` — paired machines and their daemons. */
export const Machines = component(() => {
    return () => (
        <Page title="Machines" subtitle="Daemons that run installed CLI runtimes for your agents.">
            <Table hover>
                <Table.Caption>Machines</Table.Caption>
                <Table.Head>
                    <Table.Row>
                        <Table.HeaderCell>Machine</Table.HeaderCell>
                        <Table.HeaderCell>OS</Table.HeaderCell>
                        <Table.HeaderCell>Runtimes</Table.HeaderCell>
                        <Table.HeaderCell>Last seen</Table.HeaderCell>
                    </Table.Row>
                </Table.Head>
                <Table.Body>
                    {machines.map(m => (
                        <Table.Row>
                            <Table.Cell>
                                <Row gap="sm">
                                    <Status color={m.online ? 'success' : 'neutral'} label={m.online ? 'online' : 'offline'} />
                                    <Link to={`/machines/${m.id}`}>{m.name}</Link>
                                </Row>
                            </Table.Cell>
                            <Table.Cell>{m.os}</Table.Cell>
                            <Table.Cell>{m.runtimes.join(', ')}</Table.Cell>
                            <Table.Cell>{m.lastSeen}</Table.Cell>
                        </Table.Row>
                    ))}
                </Table.Body>
            </Table>
            <Link to="/pair">Pair a new machine</Link>
        </Page>
    );
});
