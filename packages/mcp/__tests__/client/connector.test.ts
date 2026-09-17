/** The connector manifest and the static capability declaration. */
// @vitest-environment node
import type { PluginManifest } from '@agentic/core';
import { MCP_CONNECTOR_CAPABILITIES, MCP_SUPPORTED_OPS, MCP_UNSUPPORTED_OPS, capabilityReportFor, mcpConnector } from '@agentic/mcp';

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
