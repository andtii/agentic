/**
 * The plugin page's extra fixtures (#640), beside `mock/ops.ts`: the tools
 * each mock connector brings and the Registry's connector records — what
 * `/plugins/:id` reads for its Tools and Account panels on `pnpm dev:mock`.
 * Gmail's tools are the ones `gmailConnectorPlugin` declares (names,
 * titles, the modes they start in), copied so the client bundle does not
 * pull the connector engine in.
 */
import type { PluginToolDeclaration } from '@agentic/core';
import type { ConnectorRecord, PluginView } from '@agentic/platform';

/** The tools a mock plugin's manifest declares (PLG-09), by plugin id. */
export const mockPluginTools: Readonly<Record<string, readonly PluginToolDeclaration[]>> = {
    gmail: [
        { name: 'gmail__search-messages', title: 'Search messages', defaultMode: 'allow' },
        { name: 'gmail__get-message', title: 'Get message', defaultMode: 'allow' },
        { name: 'gmail__get-thread', title: 'Get conversation', defaultMode: 'allow' },
        { name: 'gmail__get-attachment', title: 'Download attachment', defaultMode: 'allow' },
        { name: 'gmail__create-draft', title: 'Create draft', defaultMode: 'ask' },
        { name: 'gmail__modify-labels', title: 'Add or remove labels', defaultMode: 'ask' },
        { name: 'gmail__send-email', title: 'Send email', defaultMode: 'ask' },
        { name: 'gmail__reply-to-message', title: 'Reply to message', defaultMode: 'ask' },
        { name: 'gmail__trash-message', title: 'Move to trash', defaultMode: 'ask' }
    ]
};

const at = Date.parse('2026-09-12T09:00:00Z');

/** The mock workspace's connector records (`Registry.connectors()`): what an MCP connector reported, where it lives. */
export const mockConnectorRecords: readonly ConnectorRecord[] = [
    {
        id: 'github-mcp', pluginId: 'github-mcp', transport: 'streamable-http', url: 'https://api.github.com/mcp', auth: { bearer: 'github-token' },
        tools: ['github-mcp__create_issue', 'github-mcp__create_pull_request', 'github-mcp__get_issue', 'github-mcp__list_issues', 'github-mcp__merge_pull_request'],
        status: { state: 'ok', checkedAt: at }, updatedAt: at
    },
    { id: 'gmail', pluginId: 'gmail', transport: 'conduit', connector: 'gmail', account: 'acct_gmail', tools: [], status: { state: 'ok', checkedAt: at }, updatedAt: at }
];

/** A mock plugin with the tools its manifest declares here. */
export function withMockTools(plugin: PluginView): PluginView {
    const tools = mockPluginTools[plugin.manifest.id];
    return tools ? { ...plugin, manifest: { ...plugin.manifest, tools } } : plugin;
}
