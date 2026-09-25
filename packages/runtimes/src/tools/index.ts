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
import { projectsTool } from './projects.js';
import { taskReportTool } from './task.js';
import { usageLimitsTool } from './usage.js';

import { planTools } from './plan.js';
import { pullReportTool } from './pulls.js';

import { requestTools } from './requests.js';

export type { ToolCall, MemoryPort, TaskPort, ChatPort, ChatPost, ChatPostResult, UserQuestion, AskOutcome, DelegateSpec, DelegateCall, DelegateOutcome, DelegateEnvironment, TaskReport, ChatFilesPort, UsagePort, ProjectPort, ProjectSummary, ChatProject, PullsPort, PullReportResult, PlatformPorts } from './ports.js';
export { memorySearchTool, memoryRememberTool, memorySearchInput, memoryRememberInput } from './memory.js';
export { delegateTool, delegateInput, delegateResult, describeEnvironments, DELEGATE_RUNNING_NOTE, type DelegateResult } from './delegate.js';
export { chatPostTool, askUserTool, chatPostInput, askUserInput } from './chat.js';
export { chatFileReadTool, chatFileReadInput, chatFileUriInput, type ChatFileReadResult } from './chatFile.js';
export { taskReportTool, taskReportInput } from './task.js';
export { usageLimitsTool, usageLimitsInput } from './usage.js';
export { projectsTool, projectsInput, type ProjectsListResult, type ProjectsSetResult } from './projects.js';

export { pullReportTool, pullReportInput } from './pulls.js';
export { planTools, planNext, planClaimRefusal, planManagerRefusal, planApplyChecks, planTouchWarnings, planItemView, PlanRefusal, planListInput, planNextInput, planClaimInput, planAssignInput, planUpdateInput, planRefInput, planAddInput, planHandoffInput, type PlanPort, type PlanBoard, type PlanMember, type PlanUpdateInput, type PlanAddInput, type NewPlanItem, type PlanItemView } from './plan.js';

export { requestTools, requestView, requestWhyLine, requestManagerRefusal, requestResolveRefusal, RequestRefusal, requestsListInput, requestsTriageInput, requestsResolveInput, projectsRequestInput, type RequestsPort, type RequestsBoard, type RequestTarget, type RequestResolution, type NewRequest, type RequestView } from './requests.js';

export const PLATFORM_TOOL_NAMES = [
    'memory_search', 'memory_remember', 'delegate', 'chat_post', 'chat_file_read', 'task_report', 'ask_user', 'usage_limits', 'projects',

    'plan_list', 'plan_next', 'plan_claim', 'plan_assign', 'plan_update', 'plan_ref', 'plan_add', 'plan_handoff',

    'requests_list', 'requests_triage', 'requests_resolve', 'projects_request',

    'pull_report',
] as const;
export type PlatformToolName = (typeof PLATFORM_TOOL_NAMES)[number];

export function isPlatformToolName(name: string): name is PlatformToolName {
    return (PLATFORM_TOOL_NAMES as readonly string[]).includes(name);
}

/** Every platform tool, bound to `ports`, in roster order. */
export function platformTools(ports: PlatformPorts): readonly AnyTool[] {
    return [
        memorySearchTool(ports.memory), memoryRememberTool(ports.memory), delegateTool(ports.task), chatPostTool(ports.chat), chatFileReadTool(ports.files), taskReportTool(ports.task), askUserTool(ports.chat), usageLimitsTool(ports.usage), projectsTool(ports.projects),

        ...planTools(ports.plan),

        ...requestTools(ports.requests),

        pullReportTool(ports.pulls),
    ];
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
