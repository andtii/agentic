/**
 * What this client does and does not do, said out loud (PLG-09). The list is
 * static — the client's scope is tools — and the report per server says
 * which unsupported features THAT server actually offers, so a host can
 * warn "server X has 12 resources you cannot reach" instead of implying parity.
 */

import type { McpImplementation, McpServerCapabilities } from './protocol.js';

export const MCP_SUPPORTED_OPS: readonly string[] = ['initialize', 'ping', 'tools/list', 'tools/call', 'tools:annotations', 'tools:structuredContent'];

export interface McpUnsupportedOp {
    readonly op: string;
    readonly reason: string;
}

export const MCP_UNSUPPORTED_OPS: readonly McpUnsupportedOp[] = [
    { op: 'resources', reason: 'resources/list, resources/read, resources/subscribe and resource templates are not consumed; the client exposes tools only' },
    { op: 'prompts', reason: 'prompts/list and prompts/get are not consumed' },
    { op: 'sampling', reason: 'sampling/createMessage from the server is refused with METHOD_NOT_FOUND; the platform never lends its model to a server' },
    { op: 'elicitation', reason: 'elicitation/create from the server is refused with METHOD_NOT_FOUND; a tool cannot ask the user mid-call' },
    { op: 'roots', reason: 'roots/list from the server is refused with METHOD_NOT_FOUND; no filesystem roots are advertised' },
    { op: 'logging', reason: 'logging/setLevel is never sent; notifications/message is dropped' },
    { op: 'completions', reason: 'completion/complete is not consumed' },
    { op: 'tasks', reason: 'long-running tool tasks (tasks/*) are not consumed; a tool call is one request' },
    { op: 'notifications/tools/list_changed', reason: 'not subscribed; tools() lists on every call instead of caching' },
    { op: 'notifications/progress', reason: 'progress tokens are not requested; progress notifications are dropped' },
    { op: 'streamable-http:get', reason: 'the standalone GET stream for server-initiated messages is not opened' },
    { op: 'streamable-http:resume', reason: 'Last-Event-ID resumption is not attempted; a broken stream fails the call' },
    { op: 'oauth', reason: 'no authorization-server discovery or token exchange; auth is a bearer token the host already holds' }
];

/** The keys of `ServerCapabilities` that name a feature this client leaves unused. */
const SERVER_FEATURES: readonly (keyof McpServerCapabilities)[] = ['resources', 'prompts', 'logging', 'completions', 'tasks'];

export interface McpCapabilityReport {
    readonly transport: 'streamable-http' | 'stdio' | 'custom';
    readonly protocolVersion: string;
    readonly server: McpImplementation;
    readonly serverCapabilities: McpServerCapabilities;
    readonly supported: readonly string[];
    readonly unsupported: readonly McpUnsupportedOp[];
    /** Features the server advertises that this client will not use — the honest gap for this server. */
    readonly offeredButUnsupported: readonly string[];
    /** `true` when the server advertises no `tools` capability: `tools()` will still try, but expect an error. */
    readonly toolsUnavailable: boolean;
}

export function capabilityReportFor(input: {
    readonly transport: McpCapabilityReport['transport'];
    readonly protocolVersion: string;
    readonly server: McpImplementation;
    readonly serverCapabilities: McpServerCapabilities;
}): McpCapabilityReport {
    const caps = input.serverCapabilities ?? {};
    const offered = SERVER_FEATURES.filter((k) => caps[k] !== undefined).map(String);
    if (caps.tools?.listChanged) offered.push('notifications/tools/list_changed');
    return {
        transport: input.transport,
        protocolVersion: input.protocolVersion,
        server: input.server,
        serverCapabilities: caps,
        supported: MCP_SUPPORTED_OPS,
        unsupported: MCP_UNSUPPORTED_OPS,
        offeredButUnsupported: offered,
        toolsUnavailable: caps.tools === undefined
    };
}
