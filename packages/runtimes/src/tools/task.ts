/** `task_report` — progress, blockers and the result of the task at hand (COL-05/06, EXE-11). */

import { defineTool } from '@sigx/ai';
import { z } from 'zod';
import type { TaskPort } from './ports.js';

export const taskReportInput = z.object({
    status: z.enum(['progress', 'blocked', 'done']).describe('progress: still working; blocked: cannot continue and why; done: the result is in summary / output.'),
    summary: z.string().min(1).describe('What happened, for the task record and whoever delegated this.'),
    output: z.unknown().optional().describe('A structured result when the task asked for one.')
});

export function taskReportTool(port: TaskPort) {
    return defineTool({
        name: 'task_report',
        description: 'Report on the task you are working on: progress, a blocker, or the final result. The delegating agent or user reads this.',
        input: taskReportInput,
        annotations: { idempotent: true },
        execute: async (input, ctx) => {
            await port.report({ status: input.status, summary: input.summary, ...(input.output !== undefined ? { output: input.output } : {}) }, { callId: ctx.toolCallId, signal: ctx.signal });
            return { ok: true, status: input.status };
        }
    });
}
