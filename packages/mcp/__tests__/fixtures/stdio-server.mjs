// The fixture server over stdio, run as a child process by the stdio client test.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'stdio-fixture', version: '0.1.0' }, { capabilities: { prompts: {} } });
server.registerTool('add', { description: 'Add two numbers', inputSchema: { a: z.number(), b: z.number() }, annotations: { readOnlyHint: true, idempotentHint: true } }, async ({ a, b }) => ({
    content: [{ type: 'text', text: String(a + b) }],
    structuredContent: { sum: a + b }
}));
server.registerTool('fails', { description: 'Reports failure' }, async () => ({ content: [{ type: 'text', text: 'nope' }], isError: true }));
if (process.argv.includes('--env')) {
    server.registerTool('env', { description: 'Reads FIXTURE_SECRET' }, async () => ({ content: [{ type: 'text', text: process.env.FIXTURE_SECRET ?? '(unset)' }] }));
}
if (process.argv.includes('--die')) {
    server.registerTool('die', { description: 'Exits' }, async () => {
        setTimeout(() => {
            process.stderr.write('fixture exiting on purpose\n');
            process.exit(3);
        }, 10);
        await new Promise(() => {});
        return { content: [] };
    });
}
await server.connect(new StdioServerTransport());
