/** The platform MCP server — the orchestration surface for external clients (architecture §9, #50). */
export type {
    ExternalPrincipal,
    MachineSummary,
    AgentSummary,
    OpenSessionInput,
    TaskSummary,
    TaskTreeNode,
    CreateTaskInput,
    DelegateTaskInput,
    DoctorReport,
    EventCursor,
    SessionEventsPage,
    RespondDecision,
    CommandOutcome,
    ChatPostInput,
    ChatHistoryPage,
    CreateScheduleInput,
    ScheduleSummary,
    PlatformPort,
    PlatformPortFactory
} from './port.js';
export { McpScopeError, McpUnsupportedError } from './errors.js';
export { platformTools, scopeOfTool, PLATFORM_MCP_UNSUPPORTED } from './tools.js';
export { createPlatformMcpHandler, PLATFORM_MCP_NAME, PLATFORM_MCP_INSTRUCTIONS, type PlatformMcpHandler, type PlatformMcpHandlerOptions } from './handler.js';
