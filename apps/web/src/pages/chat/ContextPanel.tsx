import { component, signal, type Define } from 'sigx';
import { Link } from '@sigx/router';
import type { EnvironmentId, ProjectRecord, WorkdirRef } from '@agentic/core';
import { AgentTile, Button, ConfirmDialog, EnvironmentLine, Icon, Label, QuotaBadge, StatusPill, WorkdirField, type WorkdirEnvironment } from '@agentic/ui';
import { memberQuota } from './quota';
import { effectiveWorkdir } from '../projects/model';
import { WorkdirPicker } from '../workdir/WorkdirPicker';
import { agentNamed, formatTime, type MockChatSummary } from '../../mock/workspace';
import { stoppable, type AgentIdentity, type AgentLookup, type ChatTaskRow, type TimeText } from './live';

export type HistoryAccessChoice = 'all' | 'from';

export type ContextPanelProps =
    & Define.Prop<'chat', MockChatSummary, true>
    /** The mini-tree's rows: the mock workspace's task rows, or `chatTasks` over the task index (#152). */
    & Define.Prop<'tasks', readonly ChatTaskRow[], true>
    /** Who an agent id is; the mock workspace's `agentNamed` by default. */
    & Define.Prop<'lookup', AgentLookup>
    /** Agents of the workspace that are not members yet — the add-agent dialog's picker (#34). */
    & Define.Prop<'candidates', readonly AgentIdentity[]>
    /** `14:02` for an instant; the mock workspace's zone by default, the workspace's on the live page. */
    & Define.Prop<'time', TimeText>
    /** The add-agent dialog confirmed: `{ agentId, access }`. */
    & Define.Event<'addAgent', { readonly agentId: string; readonly access: HistoryAccessChoice }>
    /** "Stop task chain" confirmed. */
    & Define.Event<'stopChain'>
    /** Where a member's folder can be picked (#193); absent, the members show no folder. */
    & Define.Prop<'environments', readonly WorkdirEnvironment[]>
    /** The machine an environment belongs to — where the picker's folder requests go (live). */
    & Define.Prop<'machineOf', (environmentId: string) => string | undefined>
    /** The chat's project (#333): a member without its own folder runs in the project's folder for its environment. */
    & Define.Prop<'project', Pick<ProjectRecord, 'folders'>>
    /** A member's folder for this chat was picked, or cleared with `null`. */
    & Define.Event<'setWorkdir', { readonly agentId: string; readonly ref: WorkdirRef | null }>;

const historyLine = (member: MockChatSummary['members'][number], time: TimeText): string => {
    const base = member.history.access === 'all' ? 'sees all history' : `Added ${time(member.history.at)} · sees history from then`;
    return member.coordinator ? `Coordinator · ${base}` : base.charAt(0).toUpperCase() + base.slice(1);
};

/**
 * The chat's right column: members with status, environment and history
 * access, the tasks in this chat, "Stop task chain", and the memory privacy
 * note (MEM-11). The add-agent dialog asks for history access (CHT-04).
 */
export const ContextPanel = component<ContextPanelProps>(({ props, emit }) => {
    const st = signal({ addAgent: false, stopChain: false, access: 'all' as HistoryAccessChoice, pick: '', picking: false, pickFor: '' });
    return () => {
        const root = props.tasks.find((t) => !t.parentId);
        const lookup = props.lookup ?? agentNamed;
        const candidates = props.candidates ?? [];
        const picked = candidates.find((c) => c.id === st.pick) ?? candidates[0];
        // What a stop would reach: a settled task is listed in the tree, never in the dialog.
        const running = stoppable(props.tasks);
        return (
            <aside data-chat-context aria-label="Members and tasks">
                <section data-context-section aria-label="Members">
                    <header data-context-head>
                        <Label>Members</Label>
                        <button type="button" data-link-button onClick={() => { st.addAgent = true; }}>Add agent</button>
                    </header>
                    <ul data-members>
                        {props.chat.members.map((member) => {
                            const a = lookup(member.agentId);
                            // The folder it runs in: its override for this chat, else the project's for its environment (#333).
                            const folder = effectiveWorkdir(member, a.environmentId, props.project);
                            return (
                                <li data-member>
                                    <AgentTile name={a.name} hue={a.hue} size={28} />
                                    <span data-member-name>{a.name}</span>
                                    <span data-member-role>{a.role}</span>
                                    <StatusPill status={member.status === 'idle' ? 'idle' : member.status} />
                                    <EnvironmentLine tone="muted" {...a.environment} />
                                    {props.environments ? <span data-member-quota><QuotaBadge {...memberQuota(a, folder.ref?.environmentId, props.environments)} /></span> : null}
                                    <span data-member-history>{historyLine(member, props.time ?? formatTime)}</span>
                                    {props.environments && a.environment.runtime !== 'anthropic-api' ? (
                                        <span data-member-workdir data-inherited={folder.inherited ? '' : undefined}>
                                            <WorkdirField
                                                compact
                                                value={folder.ref}
                                                environments={props.environments}
                                                label={`Working folder for ${a.name}`}
                                                onOpen={() => { st.pickFor = member.agentId; st.picking = true; }}
                                                onClear={() => emit('setWorkdir', { agentId: member.agentId, ref: null })}
                                            />
                                            {folder.inherited ? <span data-member-workdir-from>from project</span> : null}
                                            {member.workdir ? <button type="button" data-link-button data-member-workdir-clear onClick={() => emit('setWorkdir', { agentId: member.agentId, ref: null })}>Clear</button> : null}
                                        </span>
                                    ) : null}
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
                                const a = lookup(t.agentId);
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
                    {running.length ? <Button intent="danger" icon="stop" block onClick={() => { st.stopChain = true; }}>Stop task chain</Button> : null}
                </section>

                <p data-privacy-note>
                    <Icon name="shield" size={14} />
                    <span>Agents keep private memory here. Membership shares the chat, not their memories.</span>
                </p>

                {props.environments ? (
                    // Mounted closed from the start: a zero Dialog that mounts already open throws (signalxjs/zero#102).
                    <WorkdirPicker
                        model={() => st.picking}
                        title={st.pickFor ? `Working folder for ${lookup(st.pickFor).name}` : 'Working folder'}
                        // Opens on the folder in effect: the override, else the project's (#333).
                        value={(() => { const m = props.chat.members.find((x) => x.agentId === st.pickFor); return m ? effectiveWorkdir(m, lookup(m.agentId).environmentId, props.project).ref : null; })()}
                        environments={props.environments}
                        {...(props.machineOf ? { machineOf: props.machineOf } : {})}
                        // A daemon agent's identity names its default environment there (`identityOf`); anything else is ignored.
                        preferred={(st.pickFor ? lookup(st.pickFor).environment.machine : null) as EnvironmentId | null}
                        onSelect={(ref: WorkdirRef) => { st.picking = false; emit('setWorkdir', { agentId: st.pickFor, ref }); }}
                        onCancel={() => { st.picking = false; }}
                    />
                ) : null}
                <ConfirmDialog
                    model={() => st.addAgent}
                    title="Add an agent to this chat"
                    description="What may the agent read? Earlier messages are visible only if you allow all history (CHT-04)."
                    confirmLabel="Add agent"
                    danger={false}
                    onConfirm={() => {
                        st.addAgent = false;
                        if (picked) emit('addAgent', { agentId: picked.id, access: st.access });
                    }}
                >
                    {candidates.length ? (
                        <label data-agent-pick>
                            <span>Agent</span>
                            <select data-scope="select" data-part="select" value={picked?.id ?? ''} onChange={(e: Event) => { st.pick = (e.target as HTMLSelectElement).value; }}>
                                {candidates.map((c) => <option value={c.id}>{c.name}{c.role ? ` · ${c.role}` : ''}</option>)}
                            </select>
                        </label>
                    ) : null}
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
                    dependents={running.map((t) => t.objective)}
                    dependentsLabel={`Stops ${running.length} ${running.length === 1 ? 'task' : 'tasks'}`}
                    confirmLabel={`Stop ${running.length} ${running.length === 1 ? 'task' : 'tasks'}`}
                    onConfirm={() => { st.stopChain = false; emit('stopChain'); }}
                />
            </aside>
        );
    };
});
