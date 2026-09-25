/**
 * `delegate` — hand a task to another agent and wait for its result (COL-03/04/07).
 *
 * The tool is the thin end: it validates the model's request and calls
 * `TaskPort.delegate`, which owns collaborators, depth, concurrency, the
 * budget split and the deterministic child id `(parentTaskId, callId)`
 * (architecture §7). `openWorld` because the work leaves this session.
 *
 * The child's events are NOT nested into the parent transcript — it may run
 * on another machine. Instead, where the host lets a tool emit (`modelAgent`'s
 * `AgentToolContext`), the tool writes an `agent-start` / terminal
 * `agent-update` pair bound to its own call, so the UI renders a sub-agent
 * card that links to the child task; the result itself is the tool output.
 *
 * A wait that outlives its window (#599) answers `running` with the child's id —
 * never a bare timeout that loses it. The child goes on; calling `delegate`
 * again with `follow: <taskId>` waits for that same child. A verbatim retry
 * without `follow` is a new call id, hence a SECOND child on the same objective.
 */

import { defineTool, SchemaValidationError } from '@sigx/ai';
import type { AgentToolContext } from '@sigx/ai-agent';
import { z } from 'zod';
import type { AgentId, ArtifactRef, EnvironmentId, MachineId, ProjectId, TaskError, TaskId } from '@agentic/core';
import type { DelegateEnvironment, DelegateOutcome, TaskPort } from './ports.js';

export const delegateInput = z.object({
    assignee: z.string().min(1).describe('The id of the agent to delegate to (one of your collaborators).'),
    objective: z.string().min(1).describe('What the assignee must achieve, complete on its own: it does not see this conversation.'),
    context: z.string().optional().describe('Background the assignee needs: findings so far, constraints, links.'),
    expected: z.string().optional().describe('What a good result looks like (shape, format, acceptance).'),
    constraints: z
        .object({
            maxTurns: z.number().min(1).optional(),
            maxCostUsd: z.number().min(0).optional(),
            maxWallMs: z.number().min(0).optional()
        })
        .optional()
        .describe('Limits for the child; never wider than your own.'),
    environmentId: z.string().min(1).optional().describe('The environment the child runs in; default: the assignee’s own default, else yours. Usually leave it out.'),
    machineId: z.string().min(1).optional().describe('The machine the child runs on, where the assignee’s account is resolved; default: yours. Usually leave it out.'),
    workdir: z.string().min(1).optional().describe('The folder the child works in, absolute and inside the roots of `environmentId` (which it requires). Default: your folder when the child runs in your environment.'),
    projectId: z.string().min(1).optional().describe('The project the child works in (a project id of this workspace). Default: your own project, when you work in one. Usually leave it out.'),
    follow: z
        .string()
        .min(1)
        .optional()
        .describe('The taskId of a child an earlier delegate answered `running`: wait for that same child again instead of starting a new one. Pass it with the same assignee and objective.')
});

/** What a `running` result tells the model (#599): the child goes on, and how to wait for it without starting a second. */
export const DELEGATE_RUNNING_NOTE =
    'The child is still running and keeps going. Do not call delegate again without `follow`: a new call starts a SECOND child on the same objective. To wait for this one, call delegate with the same assignee and objective and `follow` set to this taskId; or go on with other work and follow it later.';

/** Bounds on the list a refusal carries: a daemon's `tool.result` error message is at most 4096 characters (`LIMITS.text`). */
const DESCRIBE_ENVIRONMENTS = 12;
const DESCRIBE_ROOTS = 4;
const DESCRIBE_CHARS = 2_000;

/** The environments an assignee can run in, as a refusal names them (#599): id, machine and roots, so the retry can fill `environmentId`. */
export function describeEnvironments(assignee: string, envs: readonly DelegateEnvironment[]): string {
    if (envs.length === 0) return `No paired machine reports an environment agent ${assignee} can run in.`;
    const roots = (r: readonly string[]) => (r.length === 0 ? '(none)' : r.length > DESCRIBE_ROOTS ? `${r.slice(0, DESCRIBE_ROOTS).join(', ')} and ${r.length - DESCRIBE_ROOTS} more` : r.join(', '));
    const one = (e: DelegateEnvironment) => `${e.id} on machine ${e.machineId}${e.machineName ? ` (${e.machineName})` : ''}${e.online ? '' : ', offline'} — roots ${roots(e.cwdRoots)}`;
    const shown = envs.slice(0, DESCRIBE_ENVIRONMENTS).map(one).join('; ') + (envs.length > DESCRIBE_ENVIRONMENTS ? `; and ${envs.length - DESCRIBE_ENVIRONMENTS} more` : '');
    const list = shown.length > DESCRIBE_CHARS ? `${shown.slice(0, DESCRIBE_CHARS)}…` : shown;
    return `Environments agent ${assignee} can run in: ${list}. Pass one as environmentId (with its machineId when the id is on more than one machine) and a workdir inside its roots.`;
}

/** What the model gets back: the child task's id and status, and its result flattened (COL-07). */
export interface DelegateResult {
    readonly taskId: TaskId;
    readonly status: DelegateOutcome['status'];
    readonly text?: string;
    readonly output?: unknown;
    readonly artifacts: readonly ArtifactRef[];
    /** Independently verified, not merely claimed (LRN-03). */
    readonly verified: boolean;
    readonly error?: TaskError;
    /** On `cancelled`: the work that could not be confirmed stopped (COL-12). */
    readonly notStopped?: readonly TaskId[];
    /** On `running`: the child goes on, and how to wait for it without starting a second (#599). */
    readonly note?: string;
}

export function delegateResult(outcome: DelegateOutcome): DelegateResult {
    switch (outcome.status) {
        case 'completed': {
            const r = outcome.result;
            return { taskId: outcome.taskId, status: 'completed', ...(r.text !== undefined ? { text: r.text } : {}), ...(r.output !== undefined ? { output: r.output } : {}), artifacts: r.artifacts, verified: r.verified };
        }
        case 'failed':
            return { taskId: outcome.taskId, status: 'failed', artifacts: [], verified: false, error: outcome.error };
        case 'cancelled':
            return { taskId: outcome.taskId, status: 'cancelled', artifacts: [], verified: false, notStopped: outcome.notStopped };
        case 'running':
            return { taskId: outcome.taskId, status: 'running', artifacts: [], verified: false, note: DELEGATE_RUNNING_NOTE };
    }
}

function summaryOf(outcome: DelegateOutcome): string {
    switch (outcome.status) {
        case 'completed':
            return outcome.result.text ?? 'completed';
        case 'failed':
            return `${outcome.error.code}: ${outcome.error.message}`;
        case 'cancelled':
            return outcome.notStopped.length ? `cancelled; not confirmed stopped: ${outcome.notStopped.join(', ')}` : 'cancelled';
        case 'running':
            return 'running';
    }
}

export function delegateTool(port: TaskPort) {
    return defineTool({
        name: 'delegate',
        description:
            'Assign a task to another agent and wait for its result. Use it for work that belongs to a collaborator; give the whole objective, since the assignee sees only what you send. A long child may come back `running` with its taskId: it keeps going. Never retry that call as it was, which starts a second child on the same objective; call delegate again with `follow` set to the taskId to wait for the same child.',
        input: delegateInput,
        annotations: { openWorld: true },
        execute: async (input, ctx) => {
            // A folder is only meaningful on one machine: it travels with its environment (#190).
            if (input.workdir !== undefined && input.environmentId === undefined && input.follow === undefined) {
                // Name where the assignee can run (#599): the caller has no other way to learn an environment id.
                const envs = port.environments ? await port.environments(input.assignee as AgentId).catch(() => undefined) : undefined;
                const known = envs ? ` ${describeEnvironments(input.assignee, envs)}` : '';
                throw new SchemaValidationError([{ message: 'workdir needs environmentId', path: ['workdir'] }], `delegate: workdir needs environmentId.${known}`);
            }
            const hostEmit = (ctx as Partial<AgentToolContext>).emit;
            const emit = typeof hostEmit === 'function' ? hostEmit : undefined;
            const outcome = await port.delegate(
                {
                    assignee: input.assignee as AgentId,
                    objective: input.objective,
                    context: input.context !== undefined ? [{ type: 'text', text: input.context }] : [],
                    constraints: input.constraints ?? {},
                    ...(input.expected !== undefined ? { expected: input.expected } : {}),
                    ...(input.environmentId !== undefined ? { environmentId: input.environmentId as EnvironmentId } : {}),
                    ...(input.machineId !== undefined ? { machineId: input.machineId as MachineId } : {}),
                    ...(input.workdir !== undefined ? { workdir: input.workdir } : {}),
                    ...(input.projectId !== undefined ? { projectId: input.projectId as ProjectId } : {}),
                    ...(input.follow !== undefined ? { follow: input.follow as TaskId } : {})
                },
                {
                    callId: ctx.toolCallId,
                    signal: ctx.signal,
                    onDelegated: (taskId) => emit?.({ type: 'agent-start', agentId: taskId, callId: ctx.toolCallId, kind: 'delegate', title: `${input.assignee}: ${input.objective}`, background: true })
                }
            );
            // A child still running keeps its card open: the update comes with the call that sees it settle.
            if (outcome.status !== 'running') emit?.({ type: 'agent-update', agentId: outcome.taskId, status: outcome.status, summary: summaryOf(outcome), ...(outcome.status === 'completed' && outcome.result.output !== undefined ? { output: outcome.result.output } : {}) });
            return delegateResult(outcome);
        }
    });
}
