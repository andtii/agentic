/**
 * `/tasks/:id` on the platform (#46): the Task actor's record read live
 * (`get` for the contract, status, transitions and result; `tree` for the
 * delegation chain), the same columns as the mock page. Its one failure
 * state comes from `failureOf` over the record — `Task.status` / `error.code`
 * and the `resume:` wait the router parks an interrupted turn under — so a
 * failed task names its cause (OPS-04) and interrupted work is marked
 * uncertain until a person resumes it (OPS-05). "Resume" is
 * `Routing.resume(taskId)`; "Stop chain" is `Task.cancel`.
 *
 * #368: the card names why the turn was cut (the Audit's `session.interrupted`
 * row) and where the resume stands (the router's route: re-opening, or
 * resuming automatically), a resumed task says so, and a task waiting on its
 * machine reads as a wait with the machine, since when and the deadline.
 */
import { component, effect, onUnmounted, signal, type JSXElement } from 'sigx';
import { Link } from '@sigx/router';
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
import type { TaskId, TaskTransition, WaitReason } from '@agentic/core';
import type { TaskTree, TaskView } from '@agentic/platform';
import { AgentTile, ConfirmDialog, EmptyState, EnvironmentLine, Label, StatusPill, TaskNode, TimelineList, type Tone } from '@agentic/ui';
import { KeyValue } from '../../components/KeyValue';
import { Page } from '../../components/Page';
import { Panel } from '../../components/Panel';
import { FailureNotice, failureOf, interruptionLine, interruptionOf, isResumeWait, machineOfflineDetail, machineOfflineText, useInterruptionReads, type ClockText } from '../../components/status';
import { useActorDefs, useViewer } from '../../actors/defs';
import { routingKeyOf, taskKeyOf } from '../../actors/keys';
import { formatTime } from '../../mock/workspace';
import { useAgentDirectory } from '../chat/directory';
import { useEnvironmentDirectory } from '../ops/environments';

/** What the live page tells the topbar: the record for the crumb and the two actions. */
export const taskHead = signal<{ value: { id: string; task: TaskView; stop: () => void } | null }>({ value: null });

/** The tree, depth first, as the node column draws it. */
export function flattenTree(tree: TaskTree): TaskTree[] {
    const out: TaskTree[] = [];
    const walk = (node: TaskTree): void => {
        out.push(node);
        for (const child of node.children) walk(child);
    };
    walk(tree);
    return out;
}

const TONES: Record<TaskTransition['to'], Tone> = { queued: 'muted', active: 'working', waiting: 'needs-you', completed: 'muted', failed: 'failed', cancelled: 'failed' };

/** One transition as the timeline lists it: the edge, its `why`, and the wait it parked on; a resume is marked as such. */
export function transitionText(t: TaskTransition): string {
    const why = t.why ? ` · ${t.why}` : '';
    const wait = t.wait ? ` · ${isResumeWait(t.wait) ? 'interrupted — uncertain until resumed' : t.wait.kind}` : '';
    return `${t.to}${why}${wait}`;
}

/**
 * The wait line under a node (`TaskNode.waitDetail`): a resume wait says the work is uncertain; a machine-offline
 * wait (#366) names the machine, since when, and when it fails.
 */
export function waitDetailOf(wait: WaitReason | undefined, machineName?: (id: string) => string | undefined, time: ClockText = formatTime): string | undefined {
    if (isResumeWait(wait)) return 'interrupted · uncertain';
    if (wait?.kind === 'environment-offline') return `${wait.environmentId} offline · ${wait.policy}`;
    if (wait?.kind === 'machine-offline') return machineOfflineDetail(wait, machineName?.(wait.machineId), time);
    return undefined;
}

const originText = (t: TaskView): string => {
    switch (t.origin.kind) {
        case 'user':
            return `your message in chat ${t.origin.chatId}`;
        case 'agent':
            return `delegated by ${t.origin.agentId} from task ${t.origin.taskId}`;
        case 'schedule':
            return `schedule ${t.origin.scheduleId}`;
        case 'trigger':
            return `trigger ${t.origin.triggerId}`;
        case 'external':
            return `external client ${t.origin.clientId}`;
    }
};

const dialogs = signal({ stop: false });

export const LiveTask = component<{ id: string }>(({ props }) => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const directory = useAgentDirectory(defs, viewer);
    const key = (): string | null => (viewer.workspaceId ? taskKeyOf(viewer.workspaceId, props.id) : null);
    const task = useActorState(defs.TaskActor, () => { const k = key(); return k && ([k, 'get'] as const); }, { live: true });
    const tree = useActorState(defs.TaskActor, () => { const k = key(); return k && ([k, 'tree'] as const); }, { live: true });
    const cuts = useInterruptionReads(defs, viewer, () => props.id);
    const machines = useEnvironmentDirectory(defs, viewer);
    const machineName = (id: string): string | undefined => machines.machines().find((m) => m.id === id)?.name;
    const st = signal({ error: '', recovering: false });
    const fail = (e: unknown): void => { st.error = e instanceof Error ? e.message : String(e); };

    const stop = (): void => {
        const k = key();
        if (!k) return;
        dialogs.stop = false;
        void actor(defs.TaskActor, k).cancel('user').catch(fail);
    };

    const resume = async (): Promise<void> => {
        const ws = viewer.workspaceId;
        if (!ws || st.recovering) return;
        st.recovering = true;
        st.error = '';
        try {
            await actor(defs.Routing, routingKeyOf(ws)).resume(props.id as TaskId);
        } catch (e) {
            fail(e);
        } finally {
            st.recovering = false;
        }
    };

    const stopHead = effect(() => {
        const t = task.value;
        taskHead.value = t ? { id: props.id, task: t, stop: () => { dialogs.stop = true; } } : null;
    });
    onUnmounted(stopHead);

    return (): JSXElement => {
        const t = task.value;
        if (!t) {
            const missing = task.state === 'errored' || (!viewer.pending && !viewer.workspaceId);
            return (
                <Page title={missing ? 'Task not found' : 'Task'} page="task" hideTitle>
                    {missing
                        ? <EmptyState variant="generic" title={viewer.workspaceId ? 'No task with that id' : 'Sign in to see your tasks'} caption={task.error?.message ?? `Nothing is called ${props.id}.`} slots={{ actions: () => <Link to="/tasks">Back to tasks</Link> }} />
                        : <p data-panel-note aria-busy="true">Loading task…</p>}
                </Page>
            );
        }
        const assignee = directory.lookup(t.assignee);
        const nodes = tree.value ? flattenTree(tree.value) : [{ id: t.id, status: t.status, ...(t.wait ? { wait: t.wait } : {}), owner: t.owner, assignee: t.assignee, objective: t.objective, depth: t.depth, children: [] } satisfies TaskTree];
        const route = cuts.routes().find((r) => r.taskId === t.id) ?? null;
        const interruption = interruptionOf({ audit: cuts.audit(), taskId: t.id, route, machineName });
        const failure = failureOf({ task: { id: t.id, status: t.status, ...(t.error ? { error: t.error } : {}), ...(t.wait ? { wait: t.wait } : {}) }, interruption, machineName });
        const offline = t.wait?.kind === 'machine-offline' ? t.wait : undefined;
        const uncertain = failure?.uncertain ?? false;
        const result = t.result;
        return (
            <Page title={t.objective} page="task" hideTitle>
                <section data-task-tree aria-label="Delegation tree" data-uncertain={uncertain ? '' : undefined}>
                    <header data-tree-head>
                        <Label>Delegation tree · depth {Math.max(...nodes.map((n) => n.depth)) + 1}</Label>
                    </header>
                    <div data-tree-nodes>
                        {nodes.map((n) => {
                            const a = directory.lookup(n.assignee);
                            const detail = waitDetailOf(n.wait, machineName);
                            return (
                                <TaskNode
                                    id={n.id}
                                    title={n.objective}
                                    status={n.status}
                                    agent={a.name}
                                    hue={a.hue}
                                    environment={a.environment}
                                    {...(n.wait ? { wait: n.wait } : {})}
                                    {...(detail ? { waitDetail: detail } : {})}
                                    depth={n.depth}
                                    selected={n.id === t.id}
                                />
                            );
                        })}
                    </div>
                    {t.notStopped.length ? <p data-not-stopped role="status">Could not be stopped: {t.notStopped.join(', ')}</p> : null}
                    {failure ? <FailureNotice state={failure} onResume={() => { void resume(); }} busy={st.recovering} /> : null}
                    {offline ? <p data-task-wait role="status">{machineOfflineText(offline, machineName(offline.machineId), formatTime)} <Link to={`/machines/${offline.machineId}`}>Open machine</Link></p> : null}
                    {!failure && interruption?.resume === 'resumed' ? <p data-interruption-note role="note">{interruptionLine(interruption)}</p> : null}
                    {st.error ? <p data-chat-error role="alert">{st.error}</p> : null}
                </section>

                <aside data-task-rail aria-label="Selected task">
                    <Panel label="Task contract" slots={{ aside: () => <code data-ref>{t.id}</code> }}>
                        <KeyValue rows={[
                            { label: 'Objective', value: () => t.objective },
                            { label: 'Origin', value: () => originText(t) },
                            { label: 'Assignee', value: () => <span data-inline-tile><AgentTile name={assignee.name} hue={assignee.hue} size={18} /> {assignee.name}</span> },
                            { label: 'Environment', value: () => <span data-kv-stack><EnvironmentLine tone="live" {...assignee.environment} /><small>Fixed at creation. Never switched silently.</small></span> },
                            { label: 'Status', value: () => <span data-inline-tile><StatusPill status={t.status} />{uncertain ? <small data-uncertain-note> work before the cut is uncertain</small> : null}</span> },
                            { label: 'Session', value: () => (t.sessionId ? <Link to={`/sessions/${t.sessionId}`}>{t.sessionId}</Link> : '—') },
                            { label: 'Config', value: () => <span>{assignee.name} v{t.configVersion} <Link to={`/agents/${assignee.id}`}>view</Link></span> },
                            { label: 'Limits', value: () => Object.entries(t.constraints).map(([k, v]) => `${k} ${String(v)}`).join(' · ') || 'inherited' }
                        ]} />
                    </Panel>
                    <Panel label="Transitions">
                        <TimelineList label="Transitions" entries={t.transitions.map((row, i) => ({ id: `${t.id}-${i}`, text: transitionText(row), time: formatTime(row.at), tone: TONES[row.to] }))} />
                    </Panel>
                    <Panel label="Result" slots={{ aside: () => <StatusPill status={result?.verified ? 'verified' : 'not-verified'} /> }}>
                        <p data-result-text>{result?.text ?? (t.error ? `${t.error.code}: ${t.error.message}` : `No result yet. When ${assignee.name} reports one it stays “claimed” until a verification step or you confirm it.`)}</p>
                    </Panel>
                </aside>

                <ConfirmDialog
                    model={() => dialogs.stop}
                    title="Stop this task chain?"
                    description="Every task in the chain is told to stop. Children that do not acknowledge are listed as could not be stopped (COL-12)."
                    dependents={nodes.map((n) => n.objective)}
                    dependentsLabel={`Stops ${nodes.length} ${nodes.length === 1 ? 'task' : 'tasks'}`}
                    confirmLabel={`Stop ${nodes.length} ${nodes.length === 1 ? 'task' : 'tasks'}`}
                    onConfirm={stop}
                />
            </Page>
        );
    };
});
