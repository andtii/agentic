/**
 * `tools/list` entries as `@sigx/ai` tools. The wire schema is the server's
 * `inputSchema` verbatim (`defineTool({ jsonSchema })`), so `required`,
 * `enum`, `$defs` and every other keyword reach the model untouched. The
 * local Standard Schema only checks what is cheap and certain — the value is
 * an object and every `required` key is present — and leaves full validation
 * to the server, which does it anyway. Annotations map hint-for-hint.
 */

import { defineTool, type AnyTool, type StandardSchemaV1, type ToolAnnotations } from '@sigx/ai';
import { McpToolError, type McpCallToolResult, type McpContentBlock, type McpToolDefinition } from './protocol.js';

export type McpCall = (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<McpCallToolResult>;

export interface McpToolOptions {
    /** Prepended to every tool name (`github_` → `github_create_issue`) so two servers never collide. */
    readonly prefix?: string;
}

/** Tool names a provider accepts (`defineTool` enforces it): letters, digits, `_`, `-`, at most 64 characters. */
export function toolNameFor(name: string, prefix = ''): string {
    return `${prefix}${name}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

/** A Standard Schema over the server's JSON Schema: object + required keys, nothing more. */
export function inputSchemaFor(schema: McpToolDefinition['inputSchema']): StandardSchemaV1<Record<string, unknown>, Record<string, unknown>> {
    const required = Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === 'string') : [];
    return {
        '~standard': {
            version: 1,
            vendor: 'agentic-mcp',
            validate(value: unknown) {
                if (typeof value !== 'object' || value === null || Array.isArray(value)) return { issues: [{ message: 'Expected an object of arguments' }] };
                const issues = required.filter((k) => !(k in value)).map((k) => ({ message: `Missing required argument "${k}"`, path: [k] }));
                return issues.length > 0 ? { issues } : { value: value as Record<string, unknown> };
            },
            jsonSchema: { input: () => schema, output: () => schema }
        }
    };
}

export function annotationsFor(def: McpToolDefinition): ToolAnnotations | undefined {
    const a = def.annotations;
    if (!a) return undefined;
    const out: { -readonly [K in keyof ToolAnnotations]: ToolAnnotations[K] } = {};
    if (a.readOnlyHint !== undefined) out.readOnly = a.readOnlyHint;
    if (a.destructiveHint !== undefined) out.destructive = a.destructiveHint;
    if (a.idempotentHint !== undefined) out.idempotent = a.idempotentHint;
    if (a.openWorldHint !== undefined) out.openWorld = a.openWorldHint;
    return Object.keys(out).length > 0 ? out : undefined;
}

const textOf = (content: readonly McpContentBlock[]): string =>
    content
        .filter((b): b is Extract<McpContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n');

/**
 * What the model sees: `structuredContent` when the server gives one, else the
 * text blocks joined, else the content blocks as they are (images, audio and
 * resources stay base64/URI payloads — JSON-serializable, honest, no rendering).
 */
export function outputFor(name: string, result: McpCallToolResult): unknown {
    const content = Array.isArray(result.content) ? result.content : [];
    if (result.isError) throw new McpToolError(name, textOf(content) || `Tool "${name}" failed`, content);
    if (result.structuredContent !== undefined) return result.structuredContent;
    if (content.length > 0 && content.every((b) => b.type === 'text')) return textOf(content);
    return content;
}

export function mcpTool(def: McpToolDefinition, call: McpCall, options: McpToolOptions = {}): AnyTool {
    const schema = def.inputSchema ?? { type: 'object', properties: {} };
    return defineTool({
        name: toolNameFor(def.name, options.prefix),
        description: def.description ?? def.title ?? def.name,
        input: inputSchemaFor(schema),
        jsonSchema: schema,
        ...(annotationsFor(def) ? { annotations: annotationsFor(def) } : {}),
        execute: async (input, ctx) => outputFor(def.name, await call(def.name, input, ctx.signal))
    });
}

/** Every listed tool, mapped; a name collision after sanitising is an error, never a silent overwrite. */
export function mcpTools(defs: readonly McpToolDefinition[], call: McpCall, options: McpToolOptions = {}): AnyTool[] {
    const seen = new Map<string, string>();
    return defs.map((def) => {
        const tool = mcpTool(def, call, options);
        const other = seen.get(tool.name);
        if (other !== undefined) throw new Error(`[agentic mcp] tools "${other}" and "${def.name}" both map to "${tool.name}"; set a prefix or rename one on the server`);
        seen.set(tool.name, def.name);
        return tool;
    });
}
