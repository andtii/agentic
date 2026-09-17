/** The platform tools over fake ports: validation, what reaches the port, what the model gets back. */
import { SchemaValidationError, type ToolContext } from '@sigx/ai';
import type { NewMemoryEntry } from '@agentic/core';
import { grantedPlatformTools, platformTools, PLATFORM_TOOL_NAMES, isPlatformToolName } from '../../src/index';
import { fakePorts, memoryEntry } from '../anthropic/helpers';

const ctx = (id = 'call_1', signal = new AbortController().signal): ToolContext => ({ toolCallId: id, signal });

const byName = (ports = fakePorts()) => {
    const tools = new Map(platformTools(ports).map((t) => [t.name, t] as const));
    return { ports, tool: (name: string) => tools.get(name)! };
};

describe('roster', () => {
    it('has every platform tool, in order, under provider-legal names', () => {
        const names = platformTools(fakePorts()).map((t) => t.name);
        expect(names).toEqual([...PLATFORM_TOOL_NAMES]);
        for (const n of names) expect(n).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
        expect(isPlatformToolName('memory_search')).toBe(true);
        expect(isPlatformToolName('memory.search')).toBe(false);
    });
    it('carries annotations a policy can decide on', () => {
        const { tool } = byName();
        expect(tool('memory_search').annotations).toEqual({ readOnly: true, idempotent: true });
        expect(tool('delegate').annotations).toEqual({ openWorld: true });
    });
    it('advertises a JSON Schema derived from the zod input', () => {
        const spec = byName().tool('memory_search').spec as { inputSchema?: unknown; input_schema?: unknown; parameters?: unknown };
        const schema = JSON.stringify(spec);
        expect(schema).toContain('"query"');
        expect(schema).toContain('"required"');
    });
    it('grants decide the roster: deny and absent are off, ask stays on', () => {
        const names = grantedPlatformTools(fakePorts(), [{ name: 'memory_search' }, { name: 'delegate', mode: 'deny' }, { name: 'ask_user', mode: 'ask' }, { name: 'bash' }]).map((t) => t.name);
        expect(names).toEqual(['memory_search', 'ask_user']);
        expect(grantedPlatformTools(fakePorts(), [])).toEqual([]);
    });
});

describe('memory tools', () => {
    it('memory_search maps the query, defaults the limit and returns ranked entries', async () => {
        const { ports, tool } = byName();
        const out = await tool('memory_search').run({ query: 'deploy', kinds: ['fact'] }, ctx('c1'));
        expect(ports.calls).toHaveLength(1);
        expect(ports.calls[0]).toMatchObject({ port: 'memory', op: 'search', args: { text: 'deploy', kinds: ['fact'], limit: 8 }, call: { callId: 'c1' } });
        expect(out).toEqual({ memories: [{ id: 'mem_1', kind: 'fact', text: memoryEntry.text, tags: ['deploy'], confidence: 'verified', subject: 'release process', score: 0.9 }] });
    });
    it('memory_remember stamps agent provenance and a confidence fitting the kind', async () => {
        const { ports, tool } = byName();
        await tool('memory_remember').run({ text: 'Prefers bullet points.', kind: 'preference' }, ctx());
        await tool('memory_remember').run({ text: 'The API is probably rate-limited.', kind: 'assumption', tags: ['api'] }, ctx());
        const out = await tool('memory_remember').run({ text: 'Release is Tuesday.', kind: 'fact', confidence: 'stated' }, ctx());
        const entries = ports.calls.map((c) => c.args as NewMemoryEntry);
        expect(entries.map((e) => [e.kind, e.confidence, e.tags, e.provenance.source])).toEqual([
            ['preference', 'stated', [], 'agent'],
            ['assumption', 'assumed', ['api'], 'agent'],
            ['fact', 'stated', [], 'agent']
        ]);
        expect(out).toEqual({ id: 'mem_3', kind: 'fact', confidence: 'stated' });
    });
    it('rejects bad arguments before the port is called', async () => {
        const { ports, tool } = byName();
        await expect(tool('memory_search').run({ query: '' }, ctx())).rejects.toBeInstanceOf(SchemaValidationError);
        await expect(tool('memory_remember').run({ text: 'x', kind: 'rumour' }, ctx())).rejects.toBeInstanceOf(SchemaValidationError);
        expect(ports.calls).toEqual([]);
    });
});

describe('delegate', () => {
    it('passes the contract and the call id (the child id key) to the task port and returns the outcome', async () => {
        const { ports, tool } = byName();
        const controller = new AbortController();
        const out = await tool('delegate').run({ assignee: 'agent_bob', objective: 'Audit the deps.', context: 'Repo is pnpm.', expected: 'A list.', constraints: { maxCostUsd: 1 } }, ctx('call_7', controller.signal));
        expect(ports.calls[0]).toMatchObject({
            port: 'task',
            op: 'delegate',
            args: { assignee: 'agent_bob', objective: 'Audit the deps.', context: [{ type: 'text', text: 'Repo is pnpm.' }], constraints: { maxCostUsd: 1 }, expected: 'A list.' }
        });
        expect(ports.calls[0]!.call.signal).toBe(controller.signal);
        expect(out).toEqual({ taskId: 'task_p.call_7', status: 'completed', result: { text: 'done: Audit the deps.', artifacts: [], verified: false } });
    });
    it('defaults context and constraints to empty', async () => {
        const { ports, tool } = byName();
        await tool('delegate').run({ assignee: 'agent_bob', objective: 'Go.' }, ctx());
        expect(ports.calls[0]!.args).toEqual({ assignee: 'agent_bob', objective: 'Go.', context: [], constraints: {} });
    });
});

describe('chat and task tools', () => {
    it('chat_post posts with mentions', async () => {
        const { ports, tool } = byName();
        const out = await tool('chat_post').run({ text: 'Found it.', mentions: ['agent_bob'] }, ctx());
        expect(ports.calls[0]).toMatchObject({ port: 'chat', op: 'post', args: { text: 'Found it.', mentions: ['agent_bob'] } });
        expect(out).toEqual({ messageId: 'msg_1' });
    });
    it('ask_user waits for the answer through the chat port', async () => {
        const { ports, tool } = byName(fakePorts({ answer: 'blue' }));
        const out = await tool('ask_user').run({ question: 'Which colour?', choices: ['red', 'blue'] }, ctx());
        expect(ports.calls[0]).toMatchObject({ port: 'chat', op: 'ask', args: { question: 'Which colour?', choices: ['red', 'blue'] } });
        expect(out).toEqual({ answer: 'blue' });
        await expect(tool('ask_user').run({ question: 'One?', choices: ['only'] }, ctx())).rejects.toBeInstanceOf(SchemaValidationError);
    });
    it('task_report reports and acknowledges', async () => {
        const { ports, tool } = byName();
        const out = await tool('task_report').run({ status: 'done', summary: 'Audited.', output: { count: 3 } }, ctx());
        expect(ports.calls[0]).toMatchObject({ port: 'task', op: 'report', args: { status: 'done', summary: 'Audited.', output: { count: 3 } } });
        expect(out).toEqual({ ok: true, status: 'done' });
    });
});
