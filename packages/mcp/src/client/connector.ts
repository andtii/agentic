/**
 * `mcpConnector` — the `PluginManifest` (kind `connector`) for one MCP
 * server, so the Registry can hold enabled/config/grantedPermissions for it
 * like any other plugin (PLG-01..05, AST-09). Permissions are declared up
 * front: the network host it reaches (or the machine that runs the process),
 * the secret it needs, and the tool namespace it exposes. Nothing implicit.
 *
 * Capabilities name what works (`tools`, …) and, prefixed `unsupported:`,
 * what does not (resources, prompts, sampling, elicitation, …) — PLG-09 asks
 * for the gaps to be declared, and a manifest is where a reader looks first.
 */

import type { JsonSchema, PermissionScope, PluginManifest } from '@agentic/core';
import { MCP_SUPPORTED_OPS, MCP_UNSUPPORTED_OPS } from './capabilities.js';

/** Capability strings a connector manifest carries: what works, then `unsupported:<op>` for each gap. */
export const MCP_CONNECTOR_CAPABILITIES: readonly string[] = [...MCP_SUPPORTED_OPS, ...MCP_UNSUPPORTED_OPS.map((u) => `unsupported:${u.op}`)];

export interface McpConnectorBase {
    /** Plugin id, also the tool namespace (`tools:<id>`); letters, digits, `.`, `_`, `-`. */
    readonly id: string;
    readonly name: string;
    readonly description?: string;
    readonly version?: string;
    /** Extra permissions the host wants recorded (`memory:read`, say). */
    readonly permissions?: readonly { readonly scope: PermissionScope; readonly reason: string }[];
    readonly compat?: PluginManifest['compat'];
}

export interface McpHttpConnector extends McpConnectorBase {
    readonly transport: 'streamable-http';
    readonly url: string | URL;
    /** Name of the secret holding the bearer token, when the server needs one; declares `secret:<name>`. */
    readonly secret?: string;
}

export interface McpStdioConnector extends McpConnectorBase {
    readonly transport: 'stdio';
    readonly command: string;
    readonly args?: readonly string[];
    /** The machine whose daemon spawns the process; `*` when any paired machine may. */
    readonly machine?: string;
    /** Secrets passed to the process environment; each declares `secret:<name>`. */
    readonly secrets?: readonly string[];
}

export type McpConnectorOptions = McpHttpConnector | McpStdioConnector;

const CONFIG_SCHEMA_HTTP: JsonSchema = {
    type: 'object',
    properties: {
        url: { type: 'string', format: 'uri', description: 'Streamable HTTP endpoint' },
        headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra request headers' },
        toolPrefix: { type: 'string', description: 'Prefix for every exposed tool name' }
    },
    required: ['url'],
    additionalProperties: false
};

const CONFIG_SCHEMA_STDIO: JsonSchema = {
    type: 'object',
    properties: {
        command: { type: 'string', description: 'Executable the daemon spawns' },
        args: { type: 'array', items: { type: 'string' } },
        cwd: { type: 'string' },
        env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra environment for the process' },
        toolPrefix: { type: 'string', description: 'Prefix for every exposed tool name' }
    },
    required: ['command'],
    additionalProperties: false
};

export function mcpConnector(options: McpConnectorOptions): PluginManifest {
    if (!/^[A-Za-z0-9._-]+$/.test(options.id)) throw new Error(`[agentic mcp] connector id "${options.id}" must be letters, digits, ".", "_" or "-"`);
    const permissions: { scope: PermissionScope; reason: string }[] = [];
    let config: JsonSchema;
    if (options.transport === 'streamable-http') {
        const host = new URL(String(options.url)).host;
        permissions.push({ scope: `network:${host}`, reason: `Reach the MCP server at ${host}` });
        if (options.secret !== undefined) permissions.push({ scope: `secret:${options.secret}`, reason: 'Bearer token sent on every request' });
        config = CONFIG_SCHEMA_HTTP;
    } else {
        const machine = options.machine ?? '*';
        permissions.push({ scope: `machine:${machine}`, reason: `Spawn "${options.command}" on the machine's daemon` });
        for (const s of options.secrets ?? []) permissions.push({ scope: `secret:${s}`, reason: 'Passed to the process environment' });
        config = CONFIG_SCHEMA_STDIO;
    }
    permissions.push({ scope: `tools:${options.id}`, reason: 'Expose this server\'s tools to agents that enable the connector' });
    permissions.push(...(options.permissions ?? []));
    return {
        id: options.id,
        version: options.version ?? '0.0.0',
        kind: 'connector',
        name: options.name,
        description: options.description ?? (options.transport === 'streamable-http' ? `MCP server at ${String(options.url)}` : `MCP server "${options.command}" over stdio`),
        capabilities: MCP_CONNECTOR_CAPABILITIES,
        config,
        permissions,
        compat: options.compat ?? { platform: '*', core: '*' }
    };
}
