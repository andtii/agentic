/**
 * `delegate` — hand a task to another agent and wait for its result (COL-03/04/07).
 *
 * The tool is the thin end: it validates the model's request and calls
 * `TaskPort.delegate`, which owns collaborators, depth, concurrency, the
 * budget split and the deterministic child id `(parentTaskId, callId)`
 * (architecture §7). `openWorld` because the work leaves this session.
 */

import { defineTool } from '@sigx/ai';
import { z } from 'zod';
import type { AgentId } from '@agentic/core';
import type { TaskPort } from './ports.js';

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
        .describe('Limits for the child; never wider than your own.')
});

export function delegateTool(port: TaskPort) {
    return defineTool({
        name: 'delegate',
        description: 'Assign a task to another agent and wait for its result. Use it for work that belongs to a collaborator; give the whole objective, since the assignee sees only what you send.',
        input: delegateInput,
        annotations: { openWorld: true },
        execute: (input, ctx) =>
            port.delegate(
                {
                    assignee: input.assignee as AgentId,
                    objective: input.objective,
                    context: input.context !== undefined ? [{ type: 'text', text: input.context }] : [],
                    constraints: input.constraints ?? {},
                    ...(input.expected !== undefined ? { expected: input.expected } : {})
                },
                { callId: ctx.toolCallId, signal: ctx.signal }
            )
    });
}
