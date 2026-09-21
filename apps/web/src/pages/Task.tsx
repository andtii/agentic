import { component, signal } from 'sigx';
import { Link, useRoute } from '@sigx/router';
import type { TaskId } from '@agentic/core';
import { AgentTile, ApprovalPrompt, Button, ConfirmDialog, EmptyState, EnvironmentLine, Label, StatusPill, TaskNode, TimelineList } from '@agentic/ui';
import { KeyValue } from '../components/KeyValue';
import { Page } from '../components/Page';
import { Panel } from '../components/Panel';
import { defineTopbar, routeId } from '../components/topbar';
import { FailureNotice, failureOf, interruptionLine, machineOfflineText } from '../components/status';
import { dataMode } from '../data-mode';
import { agentNamed, formatTime, loadTask, sessionsOf } from '../mock/workspace';
import { opsMachine } from '../mock/ops';
import { LiveTask, taskHead } from './task/LiveTask';

/** The stop-chain dialog is opened from the topbar, which lives outside the page. */
const dialogs = signal({ stop: false });

defineTopbar('task', (route) => {
    const id = routeId(route);
    // Live: what the page published for THIS task (`task/LiveTask.tsx`); mock: the workspace's view.
    if (dataMode() === 'live') {
        const head = taskHead.value?.id === id ? taskHead.value : null;
        return {
            crumb: head?.task.objective,
            actions: () => (head ? (
                <>
                    {head.task.sessionId ? <Link to={`/sessions/${head.task.sessionId}`} data-scope="button" data-part="root" data-color="neutral" data-variant="solid" data-intent="default"><span>Open session</span></Link> : null}
                    <Button intent="danger" icon="stop" onClick={() => head.stop()}>Stop chain</Button>
                </>
            ) : null)
        };
    }
    const v = loadTask(id);
    const session = v ? sessionsOf(v.task.id)[0] : undefined;
    return {
        crumb: v?.root.objective,
        actions: () => (
            <>
                {session ? <Link to={`/sessions/${session.id}`} data-scope="button" data-part="root" data-color="neutral" data-variant="solid" data-intent="default"><span>Open session</span></Link> : null}
                <Button intent="danger" icon="stop" onClick={() => { dialogs.stop = true; }}>Stop chain</Button>
            </>
        )
    };
});

/**
 * `/tasks/:id` — the delegation tree on the left, the selected node's
 * contract, transitions and result on the right. Selecting a node swaps the
 * rail; an open approval for the selected node renders under the tree.
 */
export const Task = component(() => {
    const route = useRoute();
    const view = () => loadTask(String(route.params.id));
    const st = signal({ selected: String(route.params.id) });
    return () => {
        if (dataMode() === 'live') return <LiveTask id={String(route.params.id)} />;
        const v = view();
        if (!v) {
            return (
                <Page title="Task not found">
                    <EmptyState variant="generic" title="No task with that id" caption={`Nothing is called ${String(route.params.id)}.`} slots={{ actions: () => <Link to="/tasks">Back to tasks</Link> }} />
                </Page>
            );
        }
        const selected = v.tree.find((t) => t.id === st.selected) ?? v.task;
        const contract = v.contracts[selected.id]!;
        const assignee = agentNamed(contract.assigneeId);
        const originator = contract.originAgentId ? agentNamed(contract.originAgentId) : undefined;
        const approval = v.approvals[selected.id];
        const result = v.results[selected.id]!;
        const depth = Math.max(...v.tree.map((t) => t.depth)) + 1;
        // The selected node's one named failure (OPS-04); interrupted work is marked uncertain (OPS-05).
        const machineName = (id: string): string | undefined => opsMachine(id)?.name;
        const failure = failureOf({ task: { id: selected.id, status: selected.status, ...(selected.wait ? { wait: selected.wait } : {}), ...(selected.error ? { error: selected.error } : {}) }, ...(selected.interruption ? { interruption: selected.interruption } : {}), machineName });
        const offline = selected.wait?.kind === 'machine-offline' ? selected.wait : undefined;
        return (
            <Page title={v.root.objective} page="task" hideTitle>
                <section data-task-tree aria-label="Delegation tree">
                    <header data-tree-head>
                        <Label>Delegation tree · depth {depth} of {v.maxDepth}</Label>
                    </header>
                    <div data-tree-nodes>
                        {v.tree.map((t) => (
                            <TaskNode
                                id={t.id}
                                title={t.objective}
                                status={t.status}
                                agent={agentNamed(t.agentId).name}
                                hue={agentNamed(t.agentId).hue}
                                environment={t.environment}
                                wait={t.wait}
                                waitDetail={t.waitDetail}
                                depth={t.depth}
                                selected={t.id === selected.id}
                                onSelect={(id: TaskId) => { st.selected = id; }}
                            />
                        ))}
                    </div>
                    {v.notStopped.length ? (
                        <p data-not-stopped role="status">
                            Could not be stopped: {v.notStopped.map((t) => t.objective).join(', ')}
                        </p>
                    ) : null}
                    {approval ? <ApprovalPrompt request={approval.request} {...approval.context} onRespond={() => undefined} /> : null}
                    {failure ? <FailureNotice state={failure} /> : null}
                    {offline ? <p data-task-wait role="status">{machineOfflineText(offline, machineName(offline.machineId), formatTime)} <Link to={`/machines/${offline.machineId}`}>Open machine</Link></p> : null}
                    {!failure && selected.interruption?.resume === 'resumed' ? <p data-interruption-note role="note">{interruptionLine(selected.interruption)}</p> : null}
                </section>

                <aside data-task-rail aria-label="Selected task">
                    <Panel label="Task contract" slots={{ aside: () => <code data-ref>{contract.ref}</code> }}>
                        <KeyValue rows={[
                            { label: 'Objective', value: () => contract.objective },
                            { label: 'Origin', value: () => <span data-inline-tile>{originator ? <AgentTile name={originator.name} hue={originator.hue} size={18} /> : <AgentTile name="You" person size={18} />} {contract.origin}</span> },
                            { label: 'Assignee', value: () => <span data-inline-tile><AgentTile name={assignee.name} hue={assignee.hue} size={18} /> {assignee.name}</span> },
                            { label: 'Environment', value: () => <span data-kv-stack><EnvironmentLine tone="live" {...contract.environment} /><small>Fixed at creation. Never switched silently.</small></span> },
                            { label: 'Constraints', value: () => contract.constraints },
                            { label: 'Expected', value: () => contract.expected },
                            { label: 'Config', value: () => <span>{contract.config} <Link to={`/agents/${assignee.id}`}>view</Link></span> },
                            { label: 'Limits', value: () => contract.limits }
                        ]} />
                    </Panel>
                    <Panel label="Transitions">
                        <TimelineList label="Transitions" entries={(v.transitions[selected.id] ?? []).map((row) => ({ id: row.id, text: row.text, time: formatTime(row.at), tone: row.tone }))} />
                    </Panel>
                    <Panel label="Result" slots={{ aside: () => <StatusPill status={result.verified ? 'verified' : 'not-verified'} /> }}>
                        <p data-result-text>{result.text}</p>
                    </Panel>
                </aside>

                <ConfirmDialog
                    model={() => dialogs.stop}
                    title="Stop this task chain?"
                    description="Every task in the chain is told to stop. Children that do not acknowledge are listed as could not be stopped (COL-12)."
                    dependents={v.tree.map((t) => t.objective)}
                    dependentsLabel={`Stops ${v.tree.length} ${v.tree.length === 1 ? 'task' : 'tasks'}`}
                    confirmLabel={`Stop ${v.tree.length} ${v.tree.length === 1 ? 'task' : 'tasks'}`}
                    onConfirm={() => { dialogs.stop = false; }}
                />
            </Page>
        );
    };
});
