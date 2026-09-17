/**
 * The transcript: `Thread` (windowed rows, stick-to-bottom), `Message` on
 * zero's `Chat`, `ToolCall`, `Reasoning`, `ApprovalPrompt` and
 * `StreamingMarkdown`, with their `ai-*` anatomies.
 *
 * The `Ai*` aliases carry `componentExportName(scope)` — the spelling an
 * api-declaring design system's generated `./components` module imports.
 */
export { aiThreadAnatomy, aiMessageAnatomy, aiToolCallAnatomy, aiReasoningAnatomy, aiApprovalAnatomy, LIFECYCLE_STATES } from './anatomy.js';
export { Thread, Thread as AiThread, threadMessages, looseRequests } from './Thread.js';
export type { ThreadProps } from './Thread.js';
export { Message, Message as AiMessage, authorOf } from './Message.js';
export type { MessageProps } from './Message.js';
export { ToolCall, ToolCall as AiToolCall } from './ToolCall.js';
export type { ToolCallProps, ThreadContextProps } from './ToolCall.js';
export { Reasoning, Reasoning as AiReasoning } from './Reasoning.js';
export type { ReasoningProps } from './Reasoning.js';
export { ApprovalPrompt, ApprovalPrompt as AiApproval, DENY_MESSAGE } from './ApprovalPrompt.js';
export type { ApprovalPromptProps, RespondFn } from './ApprovalPrompt.js';
export { StreamingMarkdown } from './StreamingMarkdown.js';
export type { StreamingMarkdownProps } from './StreamingMarkdown.js';
export { toolCallState, agentState } from './tool-state.js';
export type { ToolCallView, ToolCallPhase, LifecycleState } from './tool-state.js';
export { windowRows, unitCount, followRange, frozenRange, DEFAULT_WINDOW } from './window.js';
export type { ThreadRow, WindowRange } from './window.js';
export { nonBlank, oneLine, signature, elide } from './text.js';
