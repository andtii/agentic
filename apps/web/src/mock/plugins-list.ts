/**
 * The mock workspace's plugins as `/plugins` lists them (#637, board
 * `Plugins`): `opsPlugins` plus two more MCP connectors the workspace added,
 * so the Connectors group has more than it shows ("+ 2 more connected") and
 * Linear — whose token expired (`opsPluginFacts.signedOut`) — lands in Needs
 * attention with its Sign in fix.
 */
import type { AgentId, PluginManifest } from '@agentic/core';
import type { Dependents, PluginView } from '@agentic/platform';
import { opsPluginDependents, opsPlugins } from './ops';

const mcp = (id: string, name: string, host: string, description: string, at: string): PluginView => {
    const manifest: PluginManifest = {
        id,
        version: '1.0.0',
        kind: 'connector',
        name,
        description,
        capabilities: ['tools'],
        config: { type: 'object', properties: { url: { type: 'string', format: 'uri', title: 'Server URL', default: `https://${host}/mcp` } }, required: ['url'], additionalProperties: false },
        permissions: [
            { scope: `network:${host}`, reason: `Reaches the ${name} MCP server.` },
            { scope: `tools:${id}`, reason: 'Offers its tools to the agents that select it.' }
        ],
        compat: { platform: '*', core: '*' }
    };
    return {
        manifest,
        enabled: true,
        config: { url: `https://${host}/mcp` },
        grantedPermissions: manifest.permissions.map((p) => p.scope),
        registeredAt: Date.parse(at),
        updatedAt: Date.parse(at),
        builtin: false
    };
};

/** The list's plugins: the ops fixtures, then Linear and Slack after the connectors already there. */
export const listPlugins: readonly PluginView[] = [
    ...opsPlugins,
    mcp('linear', 'Linear', 'mcp.linear.app', 'Issues, projects and cycles as tools.', '2026-09-14T09:00:00Z'),
    mcp('slack', 'Slack', 'mcp.slack.com', 'Read channels and post messages as tools.', '2026-09-15T09:00:00Z')
];

/** `dependentsAll()` for `listPlugins`. */
export const listPluginDependents: readonly Dependents[] = [
    ...opsPluginDependents,
    { pluginId: 'linear', agents: [{ id: 'forge' as AgentId, name: 'Forge', via: ['connector'] }], schedules: [] },
    { pluginId: 'slack', agents: [], schedules: [] }
];
