import { component } from 'sigx';
import { Link } from '@sigx/router';
import { Switch, Table } from '@sigx/zero-daisyui/components';
import { Page } from '../components/Page';
import { agentById, schedules } from '../mock/data';

/** `/schedules` — recurring runs. */
export const Schedules = component(() => {
    return () => (
        <Page title="Schedules" subtitle="Recurring prompts, in the workspace's timezone.">
            <Table>
                <Table.Caption>Schedules</Table.Caption>
                <Table.Head>
                    <Table.Row>
                        <Table.HeaderCell>Name</Table.HeaderCell>
                        <Table.HeaderCell>Cron</Table.HeaderCell>
                        <Table.HeaderCell>Agent</Table.HeaderCell>
                        <Table.HeaderCell>Next run</Table.HeaderCell>
                        <Table.HeaderCell>Enabled</Table.HeaderCell>
                    </Table.Row>
                </Table.Head>
                <Table.Body>
                    {schedules.map(s => (
                        <Table.Row>
                            <Table.Cell>{s.name}</Table.Cell>
                            <Table.Cell><code>{s.cron}</code></Table.Cell>
                            <Table.Cell><Link to={`/agents/${s.agentId}`}>{agentById(s.agentId)?.name}</Link></Table.Cell>
                            <Table.Cell>{s.nextRun}</Table.Cell>
                            <Table.Cell><Switch defaultChecked={s.enabled}>{s.enabled ? 'on' : 'off'}</Switch></Table.Cell>
                        </Table.Row>
                    ))}
                </Table.Body>
            </Table>
        </Page>
    );
});
