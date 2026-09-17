/** The stdio client against the official SDK server in a child process (`fixtures/stdio-server.mjs`). */
// @vitest-environment node
import { resolve } from 'node:path';
import { SchemaValidationError } from '@sigx/ai';
import { McpError, McpToolError, McpTransportError } from '@agentic/mcp';
import { createStdioMcpClient, type StdioMcpClient } from '../../src/node/index';

const fixture = resolve(import.meta.dirname, '../fixtures/stdio-server.mjs');
const open = (args: string[] = [], env?: Record<string, string>) => createStdioMcpClient({ command: process.execPath, args: [fixture, ...args], env, name: 'stdio-test', timeoutMs: 10_000 });
const ctx = () => ({ signal: new AbortController().signal, toolCallId: 'c' });

// Each case spawns a node child; a loaded runner can take seconds to start one.
describe('createStdioMcpClient', { timeout: 30_000 }, () => {
    let client: StdioMcpClient | undefined;
    afterEach(async () => {
        await client?.close();
        client = undefined;
    });

    it('spawns the server, lists and calls tools, maps errors', async () => {
        client = await open();
        const info = await client.connect();
        expect(info.server).toEqual({ name: 'stdio-fixture', version: '0.1.0' });
        const tools = await client.tools();
        expect(tools.map((t) => t.name)).toEqual(['add', 'fails']);
        const add = tools[0]!;
        expect(add.spec.inputSchema).toMatchObject({ type: 'object', required: ['a', 'b'] });
        expect(add.annotations).toEqual({ readOnly: true, idempotent: true });
        await expect(add.run({ a: 2, b: 3 }, ctx())).resolves.toEqual({ sum: 5 });
        await expect(add.run({ a: 2 }, ctx())).rejects.toBeInstanceOf(SchemaValidationError);
        await expect(tools[1]!.run({}, ctx())).rejects.toBeInstanceOf(McpToolError);
        await expect(client.callTool('missing')).resolves.toMatchObject({ isError: true });
        const report = await client.capabilityReport();
        expect(report.transport).toBe('stdio');
        expect(report.offeredButUnsupported).toEqual(['prompts', 'notifications/tools/list_changed']);
    });

    it('passes extra environment to the process and nothing else by default', async () => {
        client = await open(['--env'], { FIXTURE_SECRET: 's3cret' });
        await expect(client.callTool('env')).resolves.toMatchObject({ content: [{ type: 'text', text: 's3cret' }] });
        await client.close();
        client = await open(['--env']);
        await expect(client.callTool('env')).resolves.toMatchObject({ content: [{ type: 'text', text: '(unset)' }] });
    });

    it('turns a dying server into a transport error carrying its stderr', async () => {
        client = await open(['--die']);
        const err = await client.callTool('die').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(McpTransportError);
        expect((err as Error).message).toContain('fixture exiting on purpose');
        await expect(client.process.exited).resolves.toMatchObject({ code: 3 });
    });

    it('fails to spawn a missing executable with a clear error', async () => {
        await expect(createStdioMcpClient({ command: 'definitely-not-an-mcp-server-xyz' })).rejects.toThrow(/definitely-not-an-mcp-server-xyz/);
    });

    it('is a McpError, not a transport error, when the server refuses a request', async () => {
        client = await open();
        await expect(client.callTool('add', { a: 'x', b: 1 })).resolves.toMatchObject({ isError: true });
        const err = await client.transport.request('resources/list').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(McpError);
        expect((err as McpError).code).toBe(-32601);
        expect(err).not.toBeInstanceOf(McpTransportError);
    });
});
