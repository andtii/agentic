import { component, type Define } from 'sigx';
import { Link } from '@sigx/router';
import { AgentTile, DataTable, StatusPill } from '@agentic/ui';
import { TELEMETRY_LIMITS } from '@agentic/core';
import { opsAgent, type OpsSession } from '../../mock/ops';
import { sessionCpuText, sessionMemoryText, type DefaultForAgent } from './live';

/** The Machine page's sessions table; the agent Sessions tab reuses it. Column template per the artboard, plus CPU and memory (#400). */
export const SESSIONS_COLS = '96px 1fr 120px 104px 56px 76px 100px';

export type SessionsTableProps =
    & Define.Prop<'sessions', readonly OpsSession[], true>
    & Define.Prop<'label', string>
    /** Agent name and hue by id; the mock workspace's roster unless the live page passes its directory. */
    & Define.Prop<'agents', (id: string) => DefaultForAgent>;

export const SessionsTable = component<SessionsTableProps>(({ props }) => () => (
    <DataTable
        cols={SESSIONS_COLS}
        label={props.label ?? 'Active sessions'}
        columns={[{ label: 'Session' }, { label: 'Task' }, { label: 'Agent' }, { label: 'Environment' }, { label: 'CPU' }, { label: 'Memory' }, { label: 'State' }]}
        class="ag-sessions"
    >
        {props.sessions.map(s => {
            const agent = (props.agents ?? opsAgent)(s.agentId);
            // The session and what it started hold more than the warning level (#400): the memory cell turns amber, never a stop.
            const heavy = s.load != null && s.load.rss >= TELEMETRY_LIMITS.sessionRss;
            return (
                <DataTable.Row>
                    <DataTable.Cell><Link to={`/sessions/${s.id}`} class="ag-ref">{s.id}</Link></DataTable.Cell>
                    <DataTable.Cell><span data-ellipsis title={s.task}>{s.task}</span></DataTable.Cell>
                    <DataTable.Cell><span data-agent-cell><AgentTile name={agent.name} hue={agent.hue} size={22} /><span>{agent.name}</span></span></DataTable.Cell>
                    <DataTable.Cell><code data-mono>{s.environment}</code></DataTable.Cell>
                    <DataTable.Cell><span data-mono data-session-load="cpu">{sessionCpuText(s.load)}</span></DataTable.Cell>
                    <DataTable.Cell><span data-mono data-session-load="memory" data-tone={heavy ? 'warning' : undefined}>{sessionMemoryText(s.load)}</span></DataTable.Cell>
                    <DataTable.Cell><StatusPill status={s.status} label={s.status === 'waiting' ? 'AWAITING' : undefined} /></DataTable.Cell>
                </DataTable.Row>
            );
        })}
    </DataTable>
));
