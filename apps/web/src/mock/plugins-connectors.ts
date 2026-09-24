/**
 * The mock workspace's connected connectors (#638), as the Connectors view
 * reads them on the platform: the plugins, the Registry's connector records
 * and the connector accounts' summaries. The board's four (`PluginsConnectors`):
 * Gmail over conduit (the same plugin and account as `mock/ops.ts`), GitHub
 * and Linear over MCP — Linear's token was refused, so it NEEDS SIGN-IN
 * (#635) — and a filesystem server alien01's daemon runs over stdio.
 */
import type { AgentId, PluginManifest, PluginReadinessFacts } from '@agentic/core';
import type { ConnectorAccountSummary, ConnectorRecord, Dependents, PluginView } from '@agentic/platform';
import { readinessFacts, signedOutPluginIds } from '../pages/plugins/readiness';
import { opsEnvironments, opsGmailAccount, opsPluginDependents, opsPluginFacts, opsPlugins } from './ops';

const ADDED = Date.parse('2026-09-12T09:00:00Z');

const mcpPlugin = (m: Omit<PluginManifest, 'kind' | 'version' | 'compat' | 'capabilities' | 'config'>): PluginView => ({
    manifest: { kind: 'connector', version: '1.0.0', compat: { platform: '*', core: '*' }, capabilities: ['tools'], config: { type: 'object', properties: {}, additionalProperties: false }, ...m },
    enabled: true,
    config: {},
    grantedPermissions: m.permissions.map((p) => p.scope),
    registeredAt: ADDED,
    updatedAt: ADDED,
    builtin: false
});

const gmail = opsPlugins.find((p) => p.manifest.id === 'gmail')!;

/** The connector plugins the mock workspace has added, in the Registry's order. */
export const connectorPlugins: readonly PluginView[] = [
    gmail,
    mcpPlugin({
        id: 'github', name: 'GitHub', description: 'Issues, pull requests and code search as tools, over streamable HTTP.',
        secrets: [{ name: 'github.token', title: 'Token', description: 'Sent as the bearer token.', required: true }],
        permissions: [{ scope: 'network:api.githubcopilot.com', reason: 'Reaches the GitHub MCP server.' }, { scope: 'secret:github.token', reason: 'Signs its requests with your token.' }, { scope: 'tools:github', reason: 'Offers its tools to the agents that select it.' }]
    }),
    mcpPlugin({
        id: 'linear', name: 'Linear', description: 'Issues and projects in Linear as tools, over streamable HTTP.',
        secrets: [{ name: 'linear.token', title: 'Token', description: 'Sent as the bearer token.', required: true }],
        permissions: [{ scope: 'network:mcp.linear.app', reason: 'Reaches the Linear MCP server.' }, { scope: 'secret:linear.token', reason: 'Signs its requests with your token.' }, { scope: 'tools:linear', reason: 'Offers its tools to the agents that select it.' }]
    }),
    mcpPlugin({
        id: 'filesystem', name: 'Filesystem', description: 'Reads and writes files in the folders alien01 allows, over stdio.',
        permissions: [{ scope: 'machine:alien01', reason: 'The daemon on alien01 spawns the server.' }, { scope: 'tools:filesystem', reason: 'Offers its tools to the agents that select it.' }]
    })
];

const GITHUB_TOOLS = ['search_code', 'search_issues', 'search_pull_requests', 'search_repositories', 'search_users', 'get_issue', 'get_issue_comments', 'create_issue', 'update_issue', 'add_issue_comment', 'list_issues', 'get_pull_request', 'get_pull_request_diff', 'get_pull_request_files', 'get_pull_request_status', 'get_pull_request_comments', 'get_pull_request_reviews', 'list_pull_requests', 'create_pull_request', 'update_pull_request', 'merge_pull_request', 'create_pending_pull_request_review', 'submit_pending_pull_request_review', 'request_copilot_review', 'get_file_contents', 'create_or_update_file', 'delete_file', 'push_files', 'create_branch', 'list_branches', 'list_commits', 'get_commit', 'list_tags', 'get_tag', 'create_repository', 'fork_repository', 'get_me', 'list_notifications'].map((t) => `github__${t}`);

/** The Registry's `connectors()` of the mock workspace. */
export const connectorRecords: readonly ConnectorRecord[] = [
    { id: 'gmail', pluginId: 'gmail', transport: 'conduit', connector: 'gmail', account: opsGmailAccount.id, tools: [], status: { state: 'ok' }, updatedAt: opsGmailAccount.updatedAt },
    { id: 'github', pluginId: 'github', transport: 'streamable-http', url: 'https://api.githubcopilot.com/mcp', secrets: ['github.token'], auth: { bearer: 'github.token' }, tools: GITHUB_TOOLS, status: { state: 'ok', checkedAt: ADDED }, updatedAt: ADDED },
    { id: 'linear', pluginId: 'linear', transport: 'streamable-http', url: 'https://mcp.linear.app', secrets: ['linear.token'], auth: { bearer: 'linear.token' }, tools: [], status: { state: 'error', error: 'initialize failed with HTTP 401', checkedAt: ADDED }, updatedAt: ADDED },
    { id: 'filesystem', pluginId: 'filesystem', transport: 'stdio', command: 'npx', args: ['@modelcontextprotocol/server-filesystem', 'C:\\Dev'], machine: 'alien01', tools: ['filesystem__read_file', 'filesystem__write_file', 'filesystem__list_directory'], status: { state: 'ok', checkedAt: ADDED }, updatedAt: ADDED }
];

/** The connector accounts' summaries: Gmail's, as `mock/ops.ts` has it. */
export const connectorAccounts: readonly ConnectorAccountSummary[] = [opsGmailAccount];

/** Who picks each connector: Gmail's as `mock/ops.ts` has it, then the board's. */
export const connectorDependents: readonly Dependents[] = [
    opsPluginDependents.find((d) => d.pluginId === 'gmail')!,
    { pluginId: 'github', agents: [{ id: 'forge' as AgentId, name: 'Forge', via: ['connector'] }], schedules: [] },
    { pluginId: 'linear', agents: [], schedules: [] },
    { pluginId: 'filesystem', agents: [{ id: 'forge' as AgentId, name: 'Forge', via: ['connector'] }, { id: 'lint' as AgentId, name: 'Lint', via: ['connector'] }], schedules: [] }
];

/** What `pluginReadiness` reads for them: the tokens are set, and who is signed out comes from the records, as live. */
export const connectorFacts = (records: readonly ConnectorRecord[] = connectorRecords): PluginReadinessFacts =>
    readinessFacts({ ...opsPluginFacts, secretNames: [...opsPluginFacts.secretNames, 'github.token', 'linear.token'] }, opsEnvironments, signedOutPluginIds(records, connectorAccounts));
