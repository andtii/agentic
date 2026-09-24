/** The connector manifest and the static capability declaration. */
// @vitest-environment node
import { configDefaults, validateConfig, type PluginManifest } from '@agentic/core';
import { MCP_CONNECTOR_CAPABILITIES, MCP_SUPPORTED_OPS, MCP_UNSUPPORTED_OPS, capabilityReportFor, mcpConnector, mcpConnectorSetup } from '@agentic/mcp';

describe('mcpConnector', () => {
    it('declares an HTTP server with its host, secret and tool namespace as permissions', () => {
        const m: PluginManifest = mcpConnector({ id: 'github', name: 'GitHub', transport: 'streamable-http', url: 'https://api.githubcopilot.com/mcp/', secret: 'github.token', version: '1.0.0' });
        expect(m).toMatchObject({ id: 'github', kind: 'connector', name: 'GitHub', version: '1.0.0', description: 'MCP server at https://api.githubcopilot.com/mcp/' });
        expect(m.permissions.map((p) => p.scope)).toEqual(['network:api.githubcopilot.com', 'secret:github.token', 'tools:github']);
        expect(m.permissions.every((p) => p.reason.length > 0)).toBe(true);
        expect(m.config).toMatchObject({ type: 'object', required: ['url'] });
        expect(m.compat).toEqual({ platform: '*', core: '*' });
    });

    it('declares a stdio server with the machine and its secrets', () => {
        const m = mcpConnector({ id: 'fs', name: 'Files', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'], machine: 'm-1', secrets: ['fs.key'], permissions: [{ scope: 'memory:read', reason: 'x' }] });
        expect(m.permissions.map((p) => p.scope)).toEqual(['machine:m-1', 'secret:fs.key', 'tools:fs', 'memory:read']);
        expect(mcpConnector({ id: 'fs', name: 'Files', transport: 'stdio', command: 'x' }).permissions[0]?.scope).toBe('machine:*');
        expect(m.config).toMatchObject({ required: ['command'] });
    });

    it('declares every credential as a manifest secret with its scope, and keeps credentials out of the config schema (#240)', () => {
        const m = mcpConnector({ id: 'acme.tools', name: 'Acme', transport: 'streamable-http', url: 'https://mcp.acme.test/mcp', secret: 'acme.token', headerSecrets: { 'X-Team': 'acme.team' } });
        expect(m.secrets).toEqual([
            { name: 'acme.token', title: 'Bearer token', description: 'Bearer token sent on every request', required: true },
            { name: 'acme.team', title: 'X-Team', description: 'Sent as the X-Team header on every request', required: true }
        ]);
        expect(m.permissions.map((p) => p.scope)).toEqual(['network:mcp.acme.test', 'secret:acme.token', 'secret:acme.team', 'tools:acme_tools']);
        expect(Object.keys((m.config as { properties: object }).properties)).toEqual(['url']);
        expect(validateConfig(m.config, configDefaults(m.config)).ok).toBe(true);
        const stdio = mcpConnector({ id: 'gh', name: 'GitHub', transport: 'stdio', command: 'gh-mcp', envSecrets: { GITHUB_TOKEN: 'github.token' } });
        expect(Object.keys((stdio.config as { properties: object }).properties)).toEqual(['command', 'args', 'cwd']);
        expect(stdio.secrets?.map((s) => s.name)).toEqual(['github.token']);
        expect(validateConfig(stdio.config, configDefaults(stdio.config)).ok).toBe(true);
    });

    it('mcpConnectorSetup gives the manifest and the record that binds each secret to where it goes', () => {
        const http = mcpConnectorSetup({ id: 'acme', name: 'Acme', transport: 'streamable-http', url: 'https://mcp.acme.test/mcp', secret: 'acme.token', headerSecrets: { 'X-Team': 'acme.team' } });
        expect(http.manifest.id).toBe('acme');
        expect(http.connector).toEqual({ id: 'acme', pluginId: 'acme', transport: 'streamable-http', url: 'https://mcp.acme.test/mcp', secrets: ['acme.token', 'acme.team'], auth: { bearer: 'acme.token', headers: { 'X-Team': 'acme.team' } } });
        const open = mcpConnectorSetup({ id: 'pub', name: 'Public', transport: 'streamable-http', url: 'https://pub.test/mcp' });
        expect(open.connector).toEqual({ id: 'pub', pluginId: 'pub', transport: 'streamable-http', url: 'https://pub.test/mcp', secrets: [] });
        const stdio = mcpConnectorSetup({ id: 'gh', name: 'GitHub', transport: 'stdio', command: 'gh-mcp', args: ['serve'], machine: 'm-1', secrets: ['GH_HOST'], envSecrets: { GITHUB_TOKEN: 'github.token' } });
        expect(stdio.connector).toEqual({ id: 'gh', pluginId: 'gh', transport: 'stdio', command: 'gh-mcp', args: ['serve'], machine: 'm-1', secrets: ['GH_HOST', 'github.token'], auth: { env: { GH_HOST: 'GH_HOST', GITHUB_TOKEN: 'github.token' } } });
    });

    it('declares probed tools under their session names, destructive ones asking (PLG-09)', () => {
        const tools = [
            { name: 'list_issues', description: 'List issues', annotations: { readOnlyHint: true } },
            { name: 'delete.repo', annotations: { destructiveHint: true, title: 'Delete repository' } },
            { name: 'create_issue' },
            { name: 'create_issue', description: 'again' }
        ];
        const m = mcpConnector({ id: 'git.hub', name: 'GitHub', transport: 'streamable-http', url: 'https://gh.test/mcp', tools });
        expect(m.tools).toEqual([
            { name: 'git_hub__list_issues', description: 'List issues', defaultMode: 'allow' },
            { name: 'git_hub__delete_repo', title: 'Delete repository', defaultMode: 'ask' },
            { name: 'git_hub__create_issue', defaultMode: 'allow' }
        ]);
        const setup = mcpConnectorSetup({ id: 'fs', name: 'Files', transport: 'stdio', command: 'x', tools: [{ name: 'rm', annotations: { destructiveHint: true } }] });
        expect(setup.manifest.tools).toEqual([{ name: 'fs__rm', defaultMode: 'ask' }]);
        expect(setup.connector).not.toHaveProperty('tools');
    });

    it('declares no tools without a probe', () => {
        expect(mcpConnector({ id: 'x', name: 'X', transport: 'streamable-http', url: 'https://x.test/mcp' })).not.toHaveProperty('tools');
        expect(mcpConnector({ id: 'x', name: 'X', transport: 'streamable-http', url: 'https://x.test/mcp', tools: [] }).tools).toEqual([]);
    });

    it('rejects an id that cannot be a tool namespace', () => {
        expect(() => mcpConnector({ id: 'a b', name: 'x', transport: 'stdio', command: 'x' })).toThrow(/connector id/);
    });

    it('lists the unsupported operations in the manifest, not just the supported ones', () => {
        const m = mcpConnector({ id: 'x', name: 'x', transport: 'stdio', command: 'x' });
        expect(m.capabilities).toBe(MCP_CONNECTOR_CAPABILITIES);
        for (const op of MCP_SUPPORTED_OPS) expect(m.capabilities).toContain(op);
        for (const u of MCP_UNSUPPORTED_OPS) expect(m.capabilities).toContain(`unsupported:${u.op}`);
        expect(MCP_UNSUPPORTED_OPS.map((u) => u.op)).toEqual(expect.arrayContaining(['resources', 'prompts', 'sampling', 'elicitation', 'roots', 'logging', 'oauth']));
        expect(MCP_UNSUPPORTED_OPS.every((u) => u.reason.length > 20)).toBe(true);
    });
});

describe('capabilityReportFor', () => {
    it('names what the server offers that the client will not use and flags a server without tools', () => {
        const report = capabilityReportFor({
            transport: 'stdio',
            protocolVersion: '2025-06-18',
            server: { name: 's', version: '1' },
            serverCapabilities: { resources: { subscribe: true }, tools: { listChanged: true }, completions: {} }
        });
        expect(report.offeredButUnsupported).toEqual(['resources', 'completions', 'notifications/tools/list_changed']);
        expect(report.toolsUnavailable).toBe(false);
        expect(report.unsupported).toBe(MCP_UNSUPPORTED_OPS);
        expect(capabilityReportFor({ transport: 'custom', protocolVersion: '2025-06-18', server: { name: 's', version: '1' }, serverCapabilities: {} })).toMatchObject({ toolsUnavailable: true, offeredButUnsupported: [] });
    });
});
