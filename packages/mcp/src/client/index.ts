/** MCP client — connect a server, expose its tools as `@sigx/ai` tools, declare what is not supported (PLG-07, PLG-09, AST-09). */
export type {
    JsonRpcId,
    JsonRpcRequest,
    JsonRpcNotification,
    JsonRpcResponse,
    JsonRpcErrorBody,
    JsonRpcMessage,
    McpImplementation,
    McpServerCapabilities,
    McpInitializeResult,
    McpToolAnnotations,
    McpToolDefinition,
    McpListToolsResult,
    McpContentBlock,
    McpCallToolResult
} from './protocol.js';
export { MCP_PROTOCOL_VERSION, MCP_SUPPORTED_VERSIONS, JSON_RPC, McpError, McpTransportError, McpToolError } from './protocol.js';
export type { McpTransport, McpRequestOptions, McpServerMessage } from './transport.js';
export { CONSUMED_NOTIFICATIONS } from './transport.js';
export type { FetchLike, McpAuth, StreamableHttpTransport, StreamableHttpTransportOptions } from './http.js';
export { createStreamableHttpTransport } from './http.js';
export type { SseEvent } from './sse.js';
export { readSse } from './sse.js';
export type { McpCall, McpToolOptions } from './tools.js';
export { mcpTool, mcpTools, toolNameFor, inputSchemaFor, annotationsFor, outputFor } from './tools.js';
export type { McpCapabilityReport, McpUnsupportedOp } from './capabilities.js';
export { MCP_SUPPORTED_OPS, MCP_UNSUPPORTED_OPS, capabilityReportFor } from './capabilities.js';
export type { McpClient, McpClientOptions, McpClientBaseOptions, McpHttpClientOptions, McpTransportClientOptions, McpServerInfo } from './client.js';
export { createMcpClient } from './client.js';
export type { McpConnectorOptions, McpConnectorBase, McpHttpConnector, McpStdioConnector, McpConnectorAuth, McpConnectorRecordInput } from './connector.js';
export { mcpConnector, mcpConnectorSetup, connectorNamespace, connectorToolPrefix, MCP_CONNECTOR_CAPABILITIES } from './connector.js';
export type { OpenMcpConnectorOptions, OpenedMcpConnector } from './open.js';
export { openMcpConnector, MCP_CONNECTOR_OPEN_TIMEOUT_MS } from './open.js';
export { McpNetworkError, guardFetch, mcpHostAllowed } from './network.js';
