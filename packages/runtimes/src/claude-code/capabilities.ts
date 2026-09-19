/** What a Claude Code environment supports, stated (AGT-09, AC-15) — including where memory comes from (MEM-10). */

import type { AgentCapabilities } from '@sigx/ai-agent';
import type { CapabilityReport } from '@agentic/core';

const OPS = {
    resume: 'session.resume',
    fork: 'session.fork',
    cancel: 'session.cancel',
    steer: 'session.steer',
    configure: 'session.configure-model',
    structured: 'turn.structured-output',
    subagents: 'session.sub-agents',
    listSessions: 'agent.list-sessions',
    inputRequest: 'turn.input-request',
    platformMemory: 'memory.platform',
    runtimeMemory: 'memory.runtime'
} as const;

export interface ClaudeCodeReportInput {
    /** Platform tools served to the session, `tool:<name>` in the report. */
    readonly tools?: readonly string[];
    /** Tools asked for that the daemon cannot serve. */
    readonly unknownTools?: readonly string[];
    /** The agent's MCP connectors this session runs without (#280), `connector:<id>` in the report. */
    readonly unavailableConnectors?: readonly { readonly id: string; readonly reason: string }[];
}

export function claudeCodeCapabilityReport(c: AgentCapabilities, input: ClaudeCodeReportInput = {}): CapabilityReport {
    const supported: string[] = [OPS.inputRequest, OPS.platformMemory];
    const unsupported: { op: string; reason: string }[] = [];
    const flag = (on: boolean, op: string, reason: string) => (on ? supported.push(op) : unsupported.push({ op, reason }));

    flag(c.resume !== false, OPS.resume, 'Claude Code cannot resume a session');
    flag(c.fork, OPS.fork, 'Claude Code cannot fork a session');
    flag(c.cancel, OPS.cancel, 'Claude Code cannot cancel a running turn');
    flag(c.steer, OPS.steer, 'a message sent mid-turn is not folded into the running turn; it waits for the next one');
    flag(c.config, OPS.configure, 'the model cannot be switched in a running session');
    flag(c.structuredOutput, OPS.structured, 'Claude Code cannot constrain a reply to a schema');
    flag(c.subagents !== 'none', OPS.subagents, 'Claude Code runs no sub-agents');
    flag(c.listSessions, OPS.listSessions, 'Claude Code cannot list its sessions');
    unsupported.push({
        op: OPS.runtimeMemory,
        reason: 'settingSources is [] — CLAUDE.md files and Claude Code settings are not loaded; memory comes from the platform, labelled in the system prompt'
    });
    if (c.permissions !== 'every-call') {
        unsupported.push({ op: 'permissions.every-call', reason: 'Claude Code decides which tool calls to ask about; the platform policy sees only those' });
    }

    for (const name of input.tools ?? []) supported.push(`tool:${name}`);
    for (const name of input.unknownTools ?? []) unsupported.push({ op: `tool:${name}`, reason: 'not a platform tool the daemon can serve' });
    for (const c of input.unavailableConnectors ?? []) unsupported.push({ op: `connector:${c.id}`, reason: c.reason });

    return {
        runtime: 'claude-code',
        supported,
        unsupported,
        resume: c.resume,
        cancel: c.cancel,
        steer: c.steer,
        permissions: c.permissions,
        tools: c.tools
    };
}
