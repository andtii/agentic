/** `openStdioMcpConnector` (#280): the fixture server as a connector — namespaced tools, credential env, bounded open. */
// @vitest-environment node
import { resolve } from 'node:path';
import { openStdioMcpConnector, type StdioMcpClient } from '../../src/node/index';

const fixture = resolve(import.meta.dirname, '../fixtures/stdio-server.mjs');
const ctx = () => ({ signal: new AbortController().signal, toolCallId: 'c' });

// Each case spawns a node child; a loaded runner can take seconds to start one.
describe('openStdioMcpConnector', { timeout: 30_000 }, () => {
    it('spawns the server with the credential variables, namespaces its tools and kills it on close', async () => {
        const opened = await openStdioMcpConnector({ id: 'acme.tools', command: process.execPath, args: [fixture, '--env'], env: { FIXTURE_SECRET: 's3cret' } });
        expect(opened.toolNames).toEqual(['acme_tools__add', 'acme_tools__fails', 'acme_tools__env']);
        const byName = new Map(opened.tools.map((t) => [t.name, t]));
        await expect(byName.get('acme_tools__add')!.run({ a: 2, b: 3 }, ctx())).resolves.toEqual({ sum: 5 });
        await expect(byName.get('acme_tools__env')!.run({}, ctx())).resolves.toBe('s3cret');
        expect(byName.get('acme_tools__add')!.annotations).toEqual({ readOnly: true, idempotent: true });
        await opened.close();
        await expect(byName.get('acme_tools__add')!.run({ a: 1, b: 1 }, ctx())).rejects.toThrow();
    });

    it('gives up at the deadline and closes a server that comes up afterwards', async () => {
        let finish!: (c: StdioMcpClient) => void;
        const closed = vi.fn(async () => undefined);
        const late = { tools: async () => [], close: closed } as unknown as StdioMcpClient;
        const create = () => new Promise<StdioMcpClient>((r) => (finish = r));
        await expect(openStdioMcpConnector({ id: 'slow', command: 'x', timeoutMs: 20, create })).rejects.toThrow(/did not list its tools within 20 ms/);
        finish(late);
        await vi.waitFor(() => expect(closed).toHaveBeenCalled());
    });

    it('closes the server when listing fails', async () => {
        const closed = vi.fn(async () => undefined);
        const broken = { tools: async () => Promise.reject(new Error('boom')), close: closed } as unknown as StdioMcpClient;
        await expect(openStdioMcpConnector({ id: 'broken', command: 'x', create: async () => broken })).rejects.toThrow('boom');
        expect(closed).toHaveBeenCalled();
    });
});
