import { component, type Define } from 'sigx';
import { Link } from '@sigx/router';
import { AgentTile, DataTable, EmptyState, EnvironmentLine, Row, StatusPill } from '@agentic/ui';
import { agentById } from '../../mock/data';
import { agentProfile, sessionRows } from '../../mock/agents';
import { age } from './format';

/** The column template the Machine page's sessions table shares (`docs/design/HANDOFF.md` → Machine). */
export const SESSIONS_COLS = '120px 1fr 300px 120px 70px';
export const SESSIONS_COLUMNS = [
    { label: 'Session' },
    { label: 'Agent' },
    { label: 'Environment' },
    { label: 'Status' },
    { label: 'Age', align: 'end' as const }
];

export type SessionsTabProps = Define.Prop<'agentId', string, true>;

/**
 * Sessions: the same table the Machine page draws (#90 exports its own; this
 * one keeps the columns identical so either can replace the other).
 */
export const SessionsTab = component<SessionsTabProps>(({ props }) => () => {
    const rows = sessionRows(props.agentId);
    if (!rows.length) return <EmptyState variant="generic" title="No sessions yet" caption="Sessions appear here as soon as this agent runs." />;
    return (
        <div data-agent-sessions="">
            <DataTable cols={SESSIONS_COLS} columns={SESSIONS_COLUMNS} label="Sessions">
                {rows.map((s) => {
                    const agent = agentById(s.agentId);
                    const profile = agentProfile(s.agentId);
                    return (
                        <DataTable.Row>
                            <DataTable.Cell><Link to={`/sessions/${s.id}`} class="mono">{s.id}</Link></DataTable.Cell>
                            <DataTable.Cell>
                                <Row gap="sm" align="center">
                                    <AgentTile name={agent?.name ?? s.agentId} hue={profile?.hue} size={22} />
                                    <span>{agent?.name ?? s.agentId}</span>
                                </Row>
                            </DataTable.Cell>
                            <DataTable.Cell><EnvironmentLine machine={s.environment.machine} runtime={s.environment.runtime} account={s.environment.account} /></DataTable.Cell>
                            <DataTable.Cell><StatusPill status={s.status} /></DataTable.Cell>
                            <DataTable.Cell><span data-align="end" class="mono" data-tone="dim">{age(s.startedAt)}</span></DataTable.Cell>
                        </DataTable.Row>
                    );
                })}
            </DataTable>
        </div>
    );
}, { name: 'SessionsTab' });
