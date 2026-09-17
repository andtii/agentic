/** `bridgedPlatformTools`: the platform's definitions, executed by the platform through `callTool`. */
import type { AnyTool, Tool } from '@sigx/ai';
import { bridgedPlatformTools } from '../../src/claude-code/index';
import { memorySearchTool, PLATFORM_TOOL_NAMES } from '../../src/index';
import { fakePorts } from '../anthropic/helpers';

/** Run a served tool the way the MCP tool server does. */
const run = (tool: AnyTool, input: unknown) => (tool as Tool).execute(input as never, { toolCallId: 'call_1', signal: new AbortController().signal } as never);

describe('bridgedPlatformTools', () => {
    it('keeps the platform definition: name, description, input schema, annotations', () => {
        const { tools, unknown } = bridgedPlatformTools(['memory_search'], async () => null);
        const original = memorySearchTool(fakePorts().memory);
        expect(unknown).toEqual([]);
        expect(tools).toHaveLength(1);
        expect(tools[0]).toMatchObject({ name: original.name, description: original.description, annotations: original.annotations });
        expect(tools[0]!.spec).toEqual(original.spec);
    });

    it('serves every platform tool in the order asked, once, and lists names it has no definition for', () => {
        const { tools, unknown } = bridgedPlatformTools(['task_report', 'jira_search', 'memory_search', 'task_report', 'memory.search'], async () => null);
        expect(tools.map((t) => t.name)).toEqual(['task_report', 'memory_search']);
        expect(unknown).toEqual(['jira_search', 'memory.search']);
        expect(bridgedPlatformTools([...PLATFORM_TOOL_NAMES], async () => null).tools.map((t) => t.name)).toEqual([...PLATFORM_TOOL_NAMES]);
    });

    it('execute sends the call to the platform and returns its result; no port runs on the daemon', async () => {
        const calls: { tool: string; input: unknown }[] = [];
        const { tools } = bridgedPlatformTools(['memory_search'], async (tool, input) => {
            calls.push({ tool, input });
            return { memories: [] };
        });
        await expect(run(tools[0]!, { query: 'deploys' })).resolves.toEqual({ memories: [] });
        expect(calls).toEqual([{ tool: 'memory_search', input: { query: 'deploys' } }]);
    });

    it('a failing platform call fails the tool call', async () => {
        const { tools } = bridgedPlatformTools(['task_report'], async () => {
            throw new Error('tool.result error: forbidden');
        });
        await expect(run(tools[0]!, { status: 'done', summary: 'x' })).rejects.toThrow(/forbidden/);
    });
});
