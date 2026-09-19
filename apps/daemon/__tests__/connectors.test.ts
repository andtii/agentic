// @vitest-environment node
/**
 * The daemon's connector opener (#280) with the real `@agentic/mcp` stdio client: a stdio connector on the spec is
 * spawned inside the environment's folders with its credential variable, and its tools are callable through the
 * Claude Code session's tool server.
 */
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CONNECTOR_CREDENTIALS_TOOL, type EnvironmentId, type LocalEnvironment, type SessionId } from '@agentic/core';
import { claudeCodeDriver } from '@agentic/runtimes/claude-code';
import { fakeListen, fakeQuery, messageStart, messageStop, RESULT, textBlocks } from '../../../packages/runtimes/__tests__/claude-code/fake-query';
import { openConnector } from '../src/drivers';

const fixture = resolve(import.meta.dirname, '../../../packages/mcp/__tests__/fixtures/stdio-server.mjs');
const root = tmpdir();
const env: LocalEnvironment = { id: 'environment_a' as EnvironmentId, name: 'work', runtime: 'claude-code', cwdRoots: [root], concurrency: 1 };

/** `listen` that keeps the adapter's MCP handler, so the test calls a served tool the way the CLI would. */
function capturingListen() {
    let handler: ((r: Request) => Promise<Response>) | undefined;
    const listen: typeof fakeListen = async (h, o) => {
        handler = h;
        return fakeListen(h, o);
    };
    const rpc = async (method: string, params: unknown): Promise<{ result?: unknown; error?: unknown }> => {
        const res = await handler!(
            new Request('http://127.0.0.1:1/mcp', {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer tok' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
            })
        );
        const text = await res.text();
        return JSON.parse(text.startsWith('{') ? text : (text.split('\n').find((l) => l.startsWith('data: '))?.slice(6) ?? text)) as { result?: unknown; error?: unknown };
    };
    return { listen, rpc };
}

describe('the daemon opens a stdio connector for a Claude Code session', { timeout: 30_000 }, () => {
    it('spawns it in the session folder with its credential variable; its tools are served and callable; close kills it', async () => {
        const { listen, rpc } = capturingListen();
        const driver = claudeCodeDriver({ query: fakeQuery(() => [messageStart(), ...textBlocks('ok'), ...messageStop(), RESULT()]).query, listen, parentEnv: {}, connectors: openConnector });
        const asked: unknown[] = [];
        const callTool = async (tool: string, input: unknown) => {
            if (tool === CONNECTOR_CREDENTIALS_TOOL) {
                asked.push(input);
                return { env: { FIXTURE_SECRET: 'from-the-registry' } };
            }
            return {};
        };
        const { session, capabilities } = await driver.open(
            env,
            { agentId: 'agent_ada', cwd: root, system: 'You are Ada.', tools: [], connectors: [{ id: 'fixture', transport: 'stdio', command: process.execPath, args: [fixture, '--env'], auth: { env: { FIXTURE_SECRET: 'fixture.secret' } } }] },
            { sessionId: 'session_1' as SessionId, callTool }
        );
        expect(asked).toEqual([{ connectorId: 'fixture' }]);
        expect(capabilities.supported).toEqual(expect.arrayContaining(['tool:fixture__add', 'tool:fixture__env']));
        for await (const _ of session.prompt('hello')) void _;

        await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cli', version: '1' } });
        const add = (await rpc('tools/call', { name: 'fixture__add', arguments: { a: 2, b: 3 } })).result as { content: { text: string }[] };
        expect(add.content[0]!.text).toContain('5');
        const secret = (await rpc('tools/call', { name: 'fixture__env', arguments: {} })).result as { content: { text: string }[] };
        expect(secret.content[0]!.text).toContain('from-the-registry');

        await session.close();
        const after = await rpc('tools/call', { name: 'fixture__add', arguments: { a: 1, b: 1 } });
        expect(JSON.stringify(after)).not.toContain('"text":"2"');
        await driver.dispose();
    });
});
