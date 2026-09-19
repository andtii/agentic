/** @agentic/mcp/node — the stdio MCP client (spawns the server; Node only, runs on the daemon). */
export type { StdioMcpClientOptions, StdioMcpClient, StdioMcpTransport } from './stdio.js';
export { createStdioMcpClient, createStdioTransport } from './stdio.js';
export type { OpenStdioMcpConnectorOptions } from './open.js';
export { openStdioMcpConnector } from './open.js';
