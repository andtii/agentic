/** What the `anthropic-api` runtime supports, stated — unsupported operations are listed, never implied (AGT-09). */

import { MODEL_AGENT_CAPABILITIES } from '@sigx/ai-agent';
import type { CapabilityReport, ToolGrant } from '@agentic/core';
import { isPlatformToolName } from '../tools/index.js';

const OPS = {
    resume: 'session.resume',
    fork: 'session.fork',
    cancel: 'session.cancel',
    steer: 'session.steer',
    configure: 'session.configure-model',
    structured: 'turn.structured-output',
    subagents: 'session.sub-agents',
    listSessions: 'agent.list-sessions',
    inputRequest: 'turn.input-request'
} as const;

/**
 * The report for one agent's roster: the engine's capabilities, the platform
 * tools on the roster as `tool:<name>`, and everything the config asked for
 * that this runtime cannot do, with the reason.
 */
export function anthropicCapabilityReport(grants: readonly ToolGrant[], roster: readonly string[]): CapabilityReport {
    const c = MODEL_AGENT_CAPABILITIES;
    const supported: string[] = [];
    if (c.resume) supported.push(OPS.resume);
    if (c.fork) supported.push(OPS.fork);
    if (c.cancel) supported.push(OPS.cancel);
    if (c.steer) supported.push(OPS.steer);
    if (c.config) supported.push(OPS.configure);
    if (c.structuredOutput) supported.push(OPS.structured);
    if (c.subagents !== 'none') supported.push(OPS.subagents);
    for (const name of roster) supported.push(`tool:${name}`);

    const unsupported: { op: string; reason: string }[] = [
        { op: OPS.inputRequest, reason: 'the engine never asks the client a question; the ask_user tool asks through the chat instead' }
    ];
    if (!c.listSessions) unsupported.push({ op: OPS.listSessions, reason: 'sessions are listed by the platform, not the engine' });
    for (const grant of grants) {
        if (grant.mode === 'deny') continue;
        if (!isPlatformToolName(grant.name)) unsupported.push({ op: `tool:${grant.name}`, reason: 'not a platform tool of this runtime' });
    }

    return {
        runtime: 'anthropic-api',
        supported,
        unsupported,
        resume: c.resume,
        cancel: c.cancel,
        steer: c.steer,
        permissions: c.permissions,
        tools: c.tools
    };
}
