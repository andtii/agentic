/**
 * Platform tools — what every runtime gives an agent, over abstract ports.
 *
 * Names are provider tool names (`[A-Za-z0-9_-]`, so `memory_search` rather
 * than `memory.search`). The roster an agent gets is the intersection of
 * these and its `ToolGrant`s: a tool is not on the roster unless granted,
 * and a skill never adds one (AGT-04).
 */

import type { AnyTool } from '@sigx/ai';
import type { ToolGrant } from '@agentic/core';
import { askUserTool, chatPostTool } from './chat.js';
import { chatFileReadTool } from './chatFile.js';
import { delegateTool } from './delegate.js';
import { memoryRememberTool, memorySearchTool } from './memory.js';
import type { PlatformPorts } from './ports.js';
import { taskReportTool } from './task.js';
import { usageLimitsTool } from './usage.js';

export type { ToolCall, MemoryPort, TaskPort, ChatPort, ChatPost, ChatPostResult, UserQuestion, DelegateSpec, DelegateCall, DelegateOutcome, TaskReport, ChatFilesPort, UsagePort, PlatformPorts } from './ports.js';
export { memorySearchTool, memoryRememberTool, memorySearchInput, memoryRememberInput } from './memory.js';
export { delegateTool, delegateInput, delegateResult, type DelegateResult } from './delegate.js';
export { chatPostTool, askUserTool, chatPostInput, askUserInput } from './chat.js';
export { chatFileReadTool, chatFileReadInput, chatFileUriInput, type ChatFileReadResult } from './chatFile.js';
export { taskReportTool, taskReportInput } from './task.js';
export { usageLimitsTool, usageLimitsInput } from './usage.js';

export const PLATFORM_TOOL_NAMES = ['memory_search', 'memory_remember', 'delegate', 'chat_post', 'chat_file_read', 'task_report', 'ask_user', 'usage_limits'] as const;
export type PlatformToolName = (typeof PLATFORM_TOOL_NAMES)[number];

export function isPlatformToolName(name: string): name is PlatformToolName {
    return (PLATFORM_TOOL_NAMES as readonly string[]).includes(name);
}

/** Every platform tool, bound to `ports`, in roster order. */
export function platformTools(ports: PlatformPorts): readonly AnyTool[] {
    return [memorySearchTool(ports.memory), memoryRememberTool(ports.memory), delegateTool(ports.task), chatPostTool(ports.chat), chatFileReadTool(ports.files), taskReportTool(ports.task), askUserTool(ports.chat), usageLimitsTool(ports.usage)];
}

/**
 * The platform tools an agent is granted. `deny` (or no grant) leaves a tool
 * off the roster; `ask` stays on it — the policy compiled from the same
 * grants asks per call (`permissions: 'every-call'`).
 */
export function grantedPlatformTools(ports: PlatformPorts, grants: readonly ToolGrant[]): readonly AnyTool[] {
    const allowed = new Set(grants.filter((g) => g.mode !== 'deny').map((g) => g.name));
    return platformTools(ports).filter((t) => allowed.has(t.name));
}
