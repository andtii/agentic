/** What a harness environment supports, stated (AGT-09, AC-15) — including where memory comes from (MEM-10). */

import type { AgentCapabilities } from '@sigx/ai-agent';
import type { CapabilityReport, RuntimeId } from '@agentic/core';

export const HARNESS_OPS = {
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

/** Which harness the report is about. */
export interface HarnessReportSubject {
    readonly runtime: RuntimeId;
    /** Its display name, in the reasons: "Claude Code", "Copilot CLI". */
    readonly name: string;
    /** Why the harness's own memory (instruction files, settings) is the project's, not platform memory. */
    readonly runtimeMemory: string;
    /** Whether the harness can put a question to the user mid-turn. Default `true`. */
    readonly inputRequest?: boolean;
}

export interface HarnessReportInput {
    /** Platform tools served to the session, `tool:<name>` in the report. */
    readonly tools?: readonly string[];
    /** Tools asked for that the daemon cannot serve. */
    readonly unknownTools?: readonly string[];
    /** The agent's MCP connectors this session runs without (#280), `connector:<id>` in the report. */
    readonly unavailableConnectors?: readonly { readonly id: string; readonly reason: string }[];
}

export function harnessCapabilityReport(subject: HarnessReportSubject, c: AgentCapabilities, input: HarnessReportInput = {}): CapabilityReport {
    const { name } = subject;
    const supported: string[] = [];
    const unsupported: { op: string; reason: string }[] = [];
    const flag = (on: boolean, op: string, reason: string) => (on ? supported.push(op) : unsupported.push({ op, reason }));

    flag(subject.inputRequest ?? true, HARNESS_OPS.inputRequest, `${name} cannot put a question to the user mid-turn`);
    supported.push(HARNESS_OPS.platformMemory);
    flag(c.resume !== false, HARNESS_OPS.resume, `${name} cannot resume a session`);
    flag(c.fork, HARNESS_OPS.fork, `${name} cannot fork a session`);
    flag(c.cancel, HARNESS_OPS.cancel, `${name} cannot cancel a running turn`);
    flag(c.steer, HARNESS_OPS.steer, 'a message sent mid-turn is not folded into the running turn; it waits for the next one');
    flag(c.config, HARNESS_OPS.configure, 'the model and permission mode cannot be switched in a running session');
    flag(c.structuredOutput, HARNESS_OPS.structured, `${name} cannot constrain a reply to a schema`);
    flag(c.subagents !== 'none', HARNESS_OPS.subagents, `${name} runs no sub-agents`);
    flag(c.listSessions, HARNESS_OPS.listSessions, `${name} cannot list its sessions`);
    unsupported.push({ op: HARNESS_OPS.runtimeMemory, reason: subject.runtimeMemory });
    if (c.permissions !== 'every-call') {
        unsupported.push({ op: 'permissions.every-call', reason: `${name} decides which tool calls to ask about; the platform policy sees only those` });
    }

    for (const tool of input.tools ?? []) supported.push(`tool:${tool}`);
    for (const tool of input.unknownTools ?? []) unsupported.push({ op: `tool:${tool}`, reason: 'not a platform tool the daemon can serve' });
    for (const conn of input.unavailableConnectors ?? []) unsupported.push({ op: `connector:${conn.id}`, reason: conn.reason });

    return {
        runtime: subject.runtime,
        supported,
        unsupported,
        resume: c.resume,
        cancel: c.cancel,
        steer: c.steer,
        permissions: c.permissions,
        tools: c.tools
    };
}
