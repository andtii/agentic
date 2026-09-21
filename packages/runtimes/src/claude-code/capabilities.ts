/** What a Claude Code environment supports, stated (AGT-09, AC-15) — including where memory comes from (MEM-10). */

import type { AgentCapabilities } from '@sigx/ai-agent';
import type { CapabilityReport } from '@agentic/core';
import { harnessCapabilityReport, type HarnessReportInput } from '../harness/capabilities.js';

export type ClaudeCodeReportInput = HarnessReportInput;

export function claudeCodeCapabilityReport(c: AgentCapabilities, input: ClaudeCodeReportInput = {}): CapabilityReport {
    return harnessCapabilityReport(
        {
            runtime: 'claude-code',
            name: 'Claude Code',
            runtimeMemory: 'CLAUDE.md and project settings are loaded from the folder (settingSources: project) and belong to the project; memory comes from the platform, labelled in the system prompt'
        },
        c,
        input
    );
}
