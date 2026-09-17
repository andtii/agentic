import { component } from 'sigx';
import { Link } from '@sigx/router';
import { Table } from '@sigx/zero-daisyui/components';
import { Page } from '../components/Page';
import { StatusBadge } from '../components/StatusBadge';
import { agents } from '../mock/data';

/** `/agents` — every agent in the workspace. */
export const Agents = component(() => {
    return () => (
        <Page title="Agents" subtitle="Persistent agents with their own identity, memory and configuration.">
            <Table hover>
                <Table.Caption>Agents</Table.Caption>
                <Table.Head>
                    <Table.Row>
                        <Table.HeaderCell>Name</Table.HeaderCell>
                        <Table.HeaderCell>Runtime</Table.HeaderCell>
                        <Table.HeaderCell>Status</Table.HeaderCell>
                        <Table.HeaderCell>Config</Table.HeaderCell>
                    </Table.Row>
                </Table.Head>
                <Table.Body>
                    {agents.map(agent => (
                        <Table.Row>
                            <Table.Cell><Link to={`/agents/${agent.id}`}>{agent.name}</Link></Table.Cell>
                            <Table.Cell><code>{agent.runtime}</code></Table.Cell>
                            <Table.Cell><StatusBadge status={agent.status} /></Table.Cell>
                            <Table.Cell>v{agent.configVersion}</Table.Cell>
                        </Table.Row>
                    ))}
                </Table.Body>
            </Table>
        </Page>
    );
});
