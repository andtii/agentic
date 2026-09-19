/** `usage_limits` — how close each account is to its provider's limits (#272, part of #261; OPS-07). */

import { defineTool } from '@sigx/ai';
import { z } from 'zod';
import type { UsageLimits } from '@agentic/core';
import type { UsagePort } from './ports.js';

export const usageLimitsInput = z.object({
    machineId: z.string().min(1).optional().describe('Only this machine.'),
    runtime: z.string().min(1).optional().describe('Only this runtime, e.g. claude-code.')
});

export function usageLimitsTool(port: UsagePort | undefined) {
    return defineTool({
        name: 'usage_limits',
        description:
            'How close each account (a machine environment) is to its provider’s usage limits — Claude Code’s current session and current week, per model where it has one: `utilization` 0..1, `status`, `resetsAt`. ' +
            'Use it when choosing an environment for delegated work. Weigh each window’s `resetsAt` and the snapshot’s `ageMs` (old, or from an offline machine, may no longer hold). ' +
            '`snapshot: null` = nothing reported yet; `not-reported` comes with a reason. Nothing is switched for you.',
        input: usageLimitsInput,
        annotations: { readOnly: true, idempotent: true },
        execute: async (input, ctx): Promise<UsageLimits> => {
            if (!port) throw new Error('usage_limits: usage limits are not available on this host');
            return port.limits({ ...(input.machineId ? { machineId: input.machineId as never } : {}), ...(input.runtime ? { runtime: input.runtime } : {}) }, { callId: ctx.toolCallId, signal: ctx.signal });
        }
    });
}
