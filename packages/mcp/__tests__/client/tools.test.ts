/** `tools/list` entries → `defineTool`: schema round trip, annotations, names, output and error shaping. */
// @vitest-environment node
import { SchemaValidationError, jsonSchemaOf } from '@sigx/ai';
import { McpToolError, annotationsFor, inputSchemaFor, mcpTool, mcpTools, outputFor, toolNameFor, type McpCall, type McpToolDefinition } from '@agentic/mcp';

const schema = {
    type: 'object',
    properties: { path: { type: 'string' }, mode: { type: 'string', enum: ['r', 'w'], default: 'r' }, nested: { $ref: '#/$defs/Opts' } },
    required: ['path', 'mode'],
    additionalProperties: false,
    $defs: { Opts: { type: 'object', properties: { deep: { type: 'boolean' } } } }
} as const;
const def: McpToolDefinition = { name: 'fs.read', title: 'Read', description: 'Read a file', inputSchema: schema, annotations: { readOnlyHint: true, idempotentHint: true, title: 'ignored' } };
const ctx = () => ({ signal: new AbortController().signal, toolCallId: 'c1' });

describe('mcpTool', () => {
    it('round-trips the input schema verbatim — required, enum, default, $defs all survive', () => {
        const tool = mcpTool(def, async () => ({ content: [] }));
        expect(tool.spec.inputSchema).toBe(schema);
        expect(tool.spec.inputSchema.required).toEqual(['path', 'mode']);
        expect(jsonSchemaOf(tool.input)).toBe(schema);
        expect(tool.description).toBe('Read a file');
    });

    it('falls back to title, then name, for the description and to an empty object schema', () => {
        expect(mcpTool({ name: 'a', title: 'Title', inputSchema: { type: 'object' } }, async () => ({ content: [] })).description).toBe('Title');
        const bare = mcpTool({ name: 'b', inputSchema: undefined as never }, async () => ({ content: [] }));
        expect(bare.description).toBe('b');
        expect(bare.spec.inputSchema).toEqual({ type: 'object', properties: {} });
    });

    it('maps annotation hints one to one and drops the MCP-only title', () => {
        expect(annotationsFor(def)).toEqual({ readOnly: true, idempotent: true });
        expect(annotationsFor({ ...def, annotations: { destructiveHint: true, openWorldHint: false } })).toEqual({ destructive: true, openWorld: false });
        expect(annotationsFor({ ...def, annotations: { title: 'only' } })).toBeUndefined();
        expect(annotationsFor({ ...def, annotations: undefined })).toBeUndefined();
    });

    it('sanitises names for providers and prefixes them, keeping the server name for the call', async () => {
        expect(toolNameFor('fs.read')).toBe('fs_read');
        expect(toolNameFor('fs.read', 'srv_')).toBe('srv_fs_read');
        expect(toolNameFor('x'.repeat(80))).toHaveLength(64);
        const calls: string[] = [];
        const call: McpCall = async (name) => {
            calls.push(name);
            return { content: [{ type: 'text', text: 'ok' }] };
        };
        const tool = mcpTool(def, call, { prefix: 'srv_' });
        expect(tool.name).toBe('srv_fs_read');
        await tool.run({ path: '/a', mode: 'r' }, ctx());
        expect(calls).toEqual(['fs.read']);
    });

    it('refuses a name collision instead of overwriting', () => {
        expect(() => mcpTools([{ name: 'a.b', inputSchema: { type: 'object' } }, { name: 'a_b', inputSchema: { type: 'object' } }], async () => ({ content: [] }))).toThrow(/both map to "a_b"/);
        expect(mcpTools([def, { name: 'other', inputSchema: { type: 'object' } }], async () => ({ content: [] })).map((t) => t.name)).toEqual(['fs_read', 'other']);
    });

    it('checks required keys locally and passes everything else through to the server', async () => {
        const std = inputSchemaFor(schema)['~standard'];
        expect(std.validate({ path: '/a', mode: 'r' })).toEqual({ value: { path: '/a', mode: 'r' } });
        expect(std.validate({ path: '/a' })).toEqual({ issues: [{ message: 'Missing required argument "mode"', path: ['mode'] }] });
        expect(std.validate('nope')).toEqual({ issues: [{ message: 'Expected an object of arguments' }] });
        // An inherited key is not an argument: JSON.stringify would drop it on the wire.
        expect(std.validate(Object.assign(Object.create({ mode: 'r' }), { path: '/a' }))).toEqual({ issues: [{ message: 'Missing required argument "mode"', path: ['mode'] }] });
        expect(inputSchemaFor({ type: 'object' })['~standard'].validate({ anything: 1 })).toEqual({ value: { anything: 1 } });
        const seen: unknown[] = [];
        const tool = mcpTool(def, async (_n, args) => {
            seen.push(args);
            return { content: [] };
        });
        await expect(tool.run({ path: '/a' }, ctx())).rejects.toBeInstanceOf(SchemaValidationError);
        await tool.run({ path: '/a', mode: 'w', extra: 1 }, ctx());
        expect(seen).toEqual([{ path: '/a', mode: 'w', extra: 1 }]);
    });

    it('shapes output: structuredContent, joined text, raw blocks, empty content, isError', () => {
        expect(outputFor('t', { content: [{ type: 'text', text: 'ignored' }], structuredContent: { a: 1 } })).toEqual({ a: 1 });
        expect(outputFor('t', { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toBe('a\nb');
        expect(outputFor('t', { content: [{ type: 'text', text: 'a' }, { type: 'resource_link', uri: 'file:///x', name: 'x' }] })).toEqual([{ type: 'text', text: 'a' }, { type: 'resource_link', uri: 'file:///x', name: 'x' }]);
        expect(outputFor('t', { content: [] })).toEqual([]);
        expect(outputFor('t', { content: undefined as never })).toEqual([]);
        expect(() => outputFor('t', { content: [{ type: 'text', text: 'boom' }], isError: true })).toThrow(McpToolError);
        expect(() => outputFor('t', { content: [], isError: true })).toThrow('Tool "t" failed');
    });
});
