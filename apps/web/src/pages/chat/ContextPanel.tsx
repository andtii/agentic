import { component, signal, type Define } from 'sigx';
import { Link } from '@sigx/router';
import { AgentTile, Button, ConfirmDialog, EnvironmentLine, Icon, Label, StatusPill } from '@agentic/ui';
import { agentNamed, formatTime, type MockChatSummary, type MockTaskRow } from '../../mock/workspace';

export type ContextPanelProps =
    & Define.Prop<'chat', MockChatSummary, true>
    & Define.Prop<'tasks', readonly MockTaskRow[], true>;

const historyLine = (member: MockChatSummary['members'][number]): string => {
    const base = member.history.access === 'all' ? 'sees all history' : `Added ${formatTime(member.history.at)} · sees history from then`;
    return member.coordinator ? `Coordinator · ${base}` : base.charAt(0).toUpperCase() + base.slice(1);
};

/**
 * The chat's right column: members with status, environment and history
 * access, the tasks in this chat, "Stop task chain", and the memory privacy
 * note (MEM-11). The add-agent dialog asks for history access (CHT-04).
 */
export const ContextPanel = component<ContextPanelProps>(({ props }) => {
    const st = signal({ addAgent: false, stopChain: false, access: 'all' as 'all' | 'from' });
    return () => {
        const root = props.tasks.find((t) => !t.parentId);
        return (
            <aside data-chat-context aria-label="Members and tasks">
                <section data-context-section aria-label="Members">
                    <header data-context-head>
                        <Label>Members</Label>
                        <button type="button" data-link-button onClick={() => { st.addAgent = true; }}>Add agent</button>
                    </header>
                    <ul data-members>
                        {props.chat.members.map((member) => {
                            const a = agentNamed(member.agentId);
                            return (
                                <li data-member>
                                    <AgentTile name={a.name} hue={a.hue} size={28} />
                                    <span data-member-name>{a.name}</span>
                                    <span data-member-role>{a.role}</span>
                                    <StatusPill status={member.status === 'idle' ? 'idle' : member.status} />
                                    <EnvironmentLine tone="muted" {...a.environment} />
                                    <span data-member-history>{historyLine(member)}</span>
                                </li>
                            );
                        })}
                    </ul>
                </section>

                <section data-context-section aria-label="Tasks in this chat">
                    <header data-context-head>
                        <Label>Tasks in this chat</Label>
                        {root ? <Link to={`/tasks/${root.id}`}>Open tree</Link> : null}
                    </header>
                    {props.tasks.length ? (
                        <ul data-mini-tree>
                            {props.tasks.map((t) => {
                                const a = agentNamed(t.agentId);
                                return (
                                    <li data-mini-node data-depth={t.depth} style={`--ag-depth: ${t.depth}`}>
                                        <span data-mini-dot data-tone={t.status === 'active' ? 'working' : t.status === 'waiting' ? 'needs-you' : 'muted'} aria-hidden="true" />
                                        <Link to={`/tasks/${t.id}`}>{t.objective}</Link>
                                        <AgentTile name={a.name} hue={a.hue} size={18} />
                                    </li>
                                );
                            })}
                        </ul>
                    ) : <p data-panel-note>No tasks yet.</p>}
                    {props.tasks.length ? <Button intent="danger" icon="stop" block onClick={() => { st.stopChain = true; }}>Stop task chain</Button> : null}
                </section>

                <p data-privacy-note>
                    <Icon name="shield" size={14} />
                    <span>Agents keep private memory here. Membership shares the chat, not their memories.</span>
                </p>

                <ConfirmDialog
                    model={() => st.addAgent}
                    title="Add an agent to this chat"
                    description="What may the agent read? Earlier messages are visible only if you allow all history (CHT-04)."
                    confirmLabel="Add agent"
                    danger={false}
                    onConfirm={() => { st.addAgent = false; }}
                >
                    <fieldset data-history-access>
                        <legend>History access</legend>
                        <label><input type="radio" name="history-access" value="all" checked={st.access === 'all'} onChange={() => { st.access = 'all'; }} /> All history</label>
                        <label><input type="radio" name="history-access" value="from" checked={st.access === 'from'} onChange={() => { st.access = 'from'; }} /> From now</label>
                    </fieldset>
                </ConfirmDialog>
                <ConfirmDialog
                    model={() => st.stopChain}
                    title="Stop the task chain?"
                    description="The root stops at the next safe point and every child is told to stop. Children that do not acknowledge are listed as could not be stopped."
                    dependents={props.tasks.map((t) => t.objective)}
                    dependentsLabel={`Stops ${props.tasks.length} ${props.tasks.length === 1 ? 'task' : 'tasks'}`}
                    confirmLabel={`Stop ${props.tasks.length} ${props.tasks.length === 1 ? 'task' : 'tasks'}`}
                    onConfirm={() => { st.stopChain = false; }}
                />
            </aside>
        );
    };
});
