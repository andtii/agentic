/**
 * The reference server the interop tests talk to: the official
 * `@modelcontextprotocol/sdk` `McpServer` (a devDependency only) with the
 * tools the tests exercise. Shared by the HTTP tests (in-process, `fetch`
 * routed to the transport) and the stdio fixture (a child process).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function fixtureServer(): McpServer {
    const server = new McpServer({ name: 'fixture', version: '1.2.3' }, { capabilities: { resources: {}, prompts: {}, logging: {} }, instructions: 'be nice' });
    server.registerTool(
        'weather',
        {
            description: 'Weather for a city',
            inputSchema: { city: z.string().describe('City name'), units: z.enum(['c', 'f']).optional() },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        async ({ city, units }) => ({
            content: [{ type: 'text', text: `${city}: 21${units ?? 'c'}` }],
            structuredContent: { city, tempC: 21 }
        })
    );
    server.registerTool('shout', { description: 'Text only', inputSchema: { text: z.string() } }, async ({ text }) => ({
        content: [
            { type: 'text', text: text.toUpperCase() },
            { type: 'text', text: '!' }
        ]
    }));
    server.registerTool('snapshot', { description: 'An image', annotations: { destructiveHint: false } }, async () => ({
        content: [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }]
    }));
    server.registerTool('fails', { description: 'Reports failure', inputSchema: { why: z.string().optional() } }, async ({ why }) => ({
        content: [{ type: 'text', text: `failed: ${why ?? 'no reason'}` }],
        isError: true
    }));
    server.registerTool('throws', { description: 'Throws' }, async () => {
        throw new Error('kaput');
    });
    server.registerTool('slow', { description: 'Waits for the signal', inputSchema: { ms: z.number() } }, async ({ ms }, extra) => {
        await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, ms);
            extra.signal.addEventListener('abort', () => {
                clearTimeout(t);
                resolve();
            });
        });
        return { content: [{ type: 'text', text: 'done' }] };
    });
    return server;
}
