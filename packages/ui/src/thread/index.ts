/**
 * The transcript: `Thread` (windowed rows, stick-to-bottom), `Message`
 * (tile, meta line, body, tools), `ToolCall`, `Reasoning`, `ApprovalPrompt`
 * and `StreamingMarkdown`, with their `ai-*` anatomies — styled to
 * `docs/design/HANDOFF.md` → "`ai-*` fragment".
 *
 * The `Ai*` aliases carry `componentExportName(scope)` — the spelling an
 * api-declaring design system's generated `./components` module imports.
 */
export { aiThreadAnatomy, aiMessageAnatomy, aiToolCallAnatomy, aiReasoningAnatomy, aiApprovalAnatomy, aiQuestionAnatomy, LIFECYCLE_STATES } from './anatomy.js';
export { Thread, Thread as AiThread, threadMessages, looseRequests, midTurn } from './Thread.js';
export type { ThreadProps, DescribeFn } from './Thread.js';
export { Message, Message as AiMessage, authorOf } from './Message.js';
export type { MessageProps, MessageAuthor } from './Message.js';
export { ToolCall, ToolCall as AiToolCall, toolIcon, OUTPUT_FOLD, OUTPUT_LOG } from './ToolCall.js';
export type { ToolCallProps, ThreadContextProps, ToolMetaFn, ApprovalContext, DescribeRequestFn } from './ToolCall.js';
export { Reasoning, Reasoning as AiReasoning, reasoningSummary } from './Reasoning.js';
export type { ReasoningProps } from './Reasoning.js';
export { ApprovalPrompt, ApprovalPrompt as AiApproval, DENY_MESSAGE, decisionText } from './ApprovalPrompt.js';
export type { ApprovalPromptProps, RespondFn, ApprovalRequester, ApprovalDecision } from './ApprovalPrompt.js';
export { StreamingMarkdown } from './StreamingMarkdown.js';
export type { StreamingMarkdownProps } from './StreamingMarkdown.js';
export { toolCallState, agentState } from './tool-state.js';
export type { ToolCallView, ToolCallPhase, LifecycleState } from './tool-state.js';
export { windowRows, unitCount, followRange, frozenRange, DEFAULT_WINDOW } from './window.js';
export type { ThreadRow, WindowRange } from './window.js';
export { nonBlank, oneLine, signature, elide } from './text.js';
export { QuestionPrompt, QuestionPrompt as AiQuestion, questionFields, questionAnswers, answerText } from './QuestionPrompt.js';
export type { QuestionPromptProps, QuestionField } from './QuestionPrompt.js';
