/**
 * `pull_report` — the `pulls` tool family (#793; PRJ-08): an agent says which pull request it opened for the task at
 * hand. The project's Pulls actor links the PR to the task, chat and session, and the task waits on the PR from then
 * on: it completes when the PR merges and fails when it is closed unmerged. A project feature declares the family
 * (the git feature's `ui.tools: ['pulls']`) and routing grants it to every session of the project.
 */

import { defineTool } from '@sigx/ai';
import { z } from 'zod';
import type { PullsPort, PullReportResult } from './ports.js';

export const pullReportInput = z.object({
    number: z.number().int().positive().describe('The number of the pull request you opened, e.g. 42 for #42.')
});

export function pullReportTool(port: PullsPort | undefined) {
    return defineTool({
        name: 'pull_report',
        description:
            'Report a pull request you opened for the task you are working on, right after opening it. The task then waits on the PR: ' +
            'it completes when the PR is merged and fails when the PR is closed without merging. Only in a project whose repo the platform watches.',
        input: pullReportInput,
        annotations: { idempotent: true },
        execute: async (input, ctx): Promise<PullReportResult> => {
            if (!port) throw new Error('pull_report: pull requests are not available on this host');
            return port.report(input.number, { callId: ctx.toolCallId, signal: ctx.signal });
        }
    });
}
