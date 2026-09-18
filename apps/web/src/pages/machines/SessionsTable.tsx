import { component, type Define } from 'sigx';
import { Link } from '@sigx/router';
import { AgentTile, DataTable, StatusPill } from '@agentic/ui';
import { opsAgent, type OpsSession } from '../../mock/ops';
import type { DefaultForAgent } from './live';

/** The Machine page's sessions table; the agent Sessions tab reuses it. Column template per the artboard. */
export const SESSIONS_COLS = '110px 1fr 140px 140px 120px';

export type SessionsTableProps =
    & Define.Prop<'sessions', readonly OpsSession[], true>
    & Define.Prop<'label', string>
    /** Agent name and hue by id; the mock workspace's roster unless the live page passes its directory. */
    & Define.Prop<'agents', (id: string) => DefaultForAgent>;

export const SessionsTable = component<SessionsTableProps>(({ props }) => () => (
    <DataTable
        cols={SESSIONS_COLS}
        label={props.label ?? 'Active sessions'}
        columns={[{ label: 'Session' }, { label: 'Task' }, { label: 'Agent' }, { label: 'Environment' }, { label: 'State' }]}
        class="ag-sessions"
    >
        {props.sessions.map(s => {
            const agent = (props.agents ?? opsAgent)(s.agentId);
            return (
                <DataTable.Row>
                    <DataTable.Cell><Link to={`/sessions/${s.id}`} class="ag-ref">{s.id}</Link></DataTable.Cell>
                    <DataTable.Cell><span data-ellipsis title={s.task}>{s.task}</span></DataTable.Cell>
                    <DataTable.Cell><span data-agent-cell><AgentTile name={agent.name} hue={agent.hue} size={22} /><span>{agent.name}</span></span></DataTable.Cell>
                    <DataTable.Cell><code data-mono>{s.environment}</code></DataTable.Cell>
                    <DataTable.Cell><StatusPill status={s.status} label={s.status === 'waiting' ? 'AWAITING' : undefined} /></DataTable.Cell>
                </DataTable.Row>
            );
        })}
    </DataTable>
));
