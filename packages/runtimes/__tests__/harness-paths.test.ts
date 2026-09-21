// @vitest-environment node
/**
 * The seams the daemon's harness store drives (#369): each runtime runs the executable it is handed — Claude Code's
 * `pathToClaudeCodeExecutable`, Copilot's `cliPath` (the SDK's stdio connection), Codex's `codexPath`.
 */
import type { EnvironmentId, LocalEnvironment, SessionId } from '@agentic/core';
import { allowAll, type AgentTurn } from '@sigx/ai-agent';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeCodeDriver } from '../src/claude-code/index';
import { spawnCodexAppServer } from '../src/codex-cli/index';
import { loadCopilotClient } from '../src/copilot-cli/index';
import { fakeListen, fakeQuery, messageStart, messageStop, RESULT, textBlocks } from './claude-code/fake-query';

describe('a located harness executable', () => {
    let dir: string;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'agentic-harness-paths-'));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('Claude Code: every query runs pathToClaudeCodeExecutable', async () => {
        const fake = fakeQuery(() => [messageStart(), ...textBlocks('Hi'), ...messageStop(), RESULT()]);
        const executable = join(dir, 'harnesses', 'claude-code', '0.3.274', 'claude');
        const driver = claudeCodeDriver({ query: fake.query, listen: fakeListen, parentEnv: {}, pathToClaudeCodeExecutable: executable });
        const env: LocalEnvironment = { id: 'environment_a' as EnvironmentId, name: 'a', runtime: 'claude-code', cwdRoots: [dir], concurrency: 1 };
        const { session } = await driver.open(env, { agentId: 'agent_a', cwd: dir, system: 's', tools: [] }, { sessionId: 'session_1' as SessionId, callTool: async () => null, policy: allowAll });
        const turn: AgentTurn = session.prompt('Hello');
        for await (const _ of turn) void _;
        await turn.result;
        expect(fake.calls[0]!.pathToClaudeCodeExecutable).toBe(executable);
        await driver.dispose();
    });

    it('Copilot: the client spawns cliPath over stdio instead of the runtime beside the SDK', async () => {
        const missing = join(dir, 'harnesses', 'copilot-cli', '1.0.14', 'copilot-runtime');
        const client = await loadCopilotClient({ env: {}, cliPath: missing });
        await expect(client.start()).rejects.toThrow(`Copilot CLI not found at ${missing}`);
    });

    it('Codex: the app-server is spawned from codexPath', async () => {
        // A launcher script stands in for the native binary: it answers `initialize` with the arguments it was run with.
        const script = join(dir, 'codex.mjs');
        await writeFile(
            script,
            [
                "import { createInterface } from 'node:readline';",
                'createInterface({ input: process.stdin }).on("line", (line) => {',
                '    const m = JSON.parse(line);',
                '    if (m.method === "initialize") process.stdout.write(JSON.stringify({ id: m.id, result: { userAgent: "located/" + process.argv.slice(2).join(" "), codexHome: process.env.CODEX_HOME ?? "", platformFamily: "test", platformOs: "test" } }) + "\\n");',
                '});'
            ].join('\n')
        );
        const env: LocalEnvironment = { id: 'environment_x' as EnvironmentId, name: 'x', runtime: 'codex-cli', profileDir: join(dir, 'codex-home'), cwdRoots: [dir], concurrency: 1 };
        const connection = await spawnCodexAppServer(env, { codexPath: script, parentEnv: { PATH: process.env.PATH ?? '' }, timeoutMs: 10_000 });
        try {
            expect(connection.info).toMatchObject({ userAgent: 'located/app-server', codexHome: join(dir, 'codex-home') });
        } finally {
            await connection.close();
        }
    });
});
