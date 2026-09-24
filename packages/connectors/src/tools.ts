/**
 * `conduitTools` — one connected conduit account as the tools a session gets
 * (#531). The result has the platform's `OpenedConnector` shape
 * (`{ tools, toolNames, close }`, `packages/platform/src/routing/connectors.ts`),
 * built structurally since this package sits below `@agentic/platform`.
 *
 * - One tool per operation of kind `action` or `search`, named
 *   `<id>__<operation>` (the same namespace an MCP connector's tools get).
 *   `options` operations feed form pickers and `trigger`s are delivered, not
 *   called, so neither becomes a tool.
 * - The input schema and description are the spec's own; the `x-` UI hints
 *   are dropped from what the model sees. Full validation stays with conduit,
 *   which checks every call against the spec anyway.
 * - Hints come from the spec's intent, never from the operation's name — see
 *   `operationAnnotations`. `connectorPolicy` then rules on a conduit tool
 *   exactly as on an MCP one.
 * - Errors reach the agent as tool errors with a plain message; an account
 *   that needs reconnecting says so and asks the agent to tell the owner.
 */

import {
    ConduitAuthError,
    ConduitRequestError,
    ConduitValidationError,
    type InputIssue,
    type InputSchema,
    type OperationSpec,
    type RequestSpec
} from '@aigntiq/conduit';
import { defineTool, type AnyTool, type StandardSchemaV1, type ToolAnnotations } from '@sigx/ai';
import type { ConnectorEngine } from './engine.js';
import { ConnectorNetworkError } from './network.js';

export interface ConduitToolsOptions {
    /** The connector id in the workspace; its tools are named `<id>__<operation>`. */
    readonly id: string;
    /** The conduit connector id (`gmail`). */
    readonly connector: string;
    /** The conduit account id the owner connected. */
    readonly account: string;
    /** The account's owner key (the workspace). */
    readonly owner: string;
}

/** The platform's `OpenedConnector`, structurally. */
export interface OpenedConduitConnector {
    readonly tools: readonly AnyTool[];
    /** The names the session sees (`gmail__send-email`). */
    readonly toolNames: readonly string[];
    close(): Promise<void>;
}

/** A tool call that failed; the message is what the agent reads. */
export class ConnectorToolError extends Error {
    override readonly name = 'ConnectorToolError';
    constructor(
        message: string,
        /** The tool as the session names it. */
        readonly tool: string,
        /** Stable: `needs_reauth`, conduit's own code otherwise. */
        readonly code: string,
        options?: { cause?: unknown }
    ) {
        super(message, options);
    }
}

/** A connector's tool namespace: its id as a provider accepts it (`.` → `_`), as for MCP connectors. */
export function connectorNamespace(id: string): string {
    return id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

/** `<namespace>__<operation>`, in the characters and length a provider accepts. */
export function connectorToolName(id: string, operation: string): string {
    return `${connectorNamespace(id)}__${operation}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

/** Operations that become tools: the ones a caller runs (`action`, `search`). */
export function isToolOperation(op: OperationSpec): op is Extract<OperationSpec, { kind: 'action' | 'search' }> {
    return op.kind === 'action' || op.kind === 'search';
}

const SAFE_METHODS = new Set(['GET', 'HEAD']);

/** A request that reads only: a literal safe HTTP method (default `GET`). A templated method is not known to be safe. */
function reads(request: RequestSpec): boolean {
    return request.method === undefined || SAFE_METHODS.has(request.method);
}

/**
 * The hints the spec declares for an operation:
 * - `destructive: true` on the operation → `destructive`.
 * - a `search` (the spec's kind for listing) → `readOnly`.
 * - an `action` whose request and every step use a safe HTTP method → `readOnly`.
 * - anything else → no hint, which the platform rules on as `network`.
 */
export function operationAnnotations(op: OperationSpec): ToolAnnotations | undefined {
    if (op.destructive === true) return { destructive: true };
    if (op.kind === 'search') return { readOnly: true };
    if (op.kind === 'action' && reads(op.request) && (op.steps ?? []).every(reads)) return { readOnly: true };
    return undefined;
}

/** `value` without the `x-` UI hints (widgets, groups, option sources, cross-field rules), at every depth. */
function withoutHints(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(withoutHints);
    if (typeof value !== 'object' || value === null) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (!k.startsWith('x-')) out[k] = withoutHints(v);
    return out;
}

/** The wire schema the model sees for an operation's inputs. */
export function operationInputSchema(inputs: InputSchema | undefined): Record<string, unknown> {
    return inputs ? (withoutHints(inputs) as Record<string, unknown>) : { type: 'object', properties: {} };
}

/** A Standard Schema that checks only what is cheap and certain — an object, every `required` key present. */
function argumentsSchema(schema: Record<string, unknown>): StandardSchemaV1<Record<string, unknown>, Record<string, unknown>> {
    const required = Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === 'string') : [];
    return {
        '~standard': {
            version: 1,
            vendor: 'agentic-connectors',
            validate(value: unknown) {
                if (typeof value !== 'object' || value === null || Array.isArray(value)) return { issues: [{ message: 'Expected an object of arguments' }] };
                const issues = required.filter((k) => !Object.hasOwn(value, k)).map((k) => ({ message: `Missing required argument "${k}"`, path: [k] }));
                return issues.length > 0 ? { issues } : { value: value as Record<string, unknown> };
            },
            jsonSchema: { input: () => schema, output: () => schema }
        }
    };
}

const issuesText = (issues: readonly InputIssue[] | undefined): string => (issues ?? []).map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ');

/** What the agent reads when a call fails. Unknown errors are passed on as they are. */
function toolError(e: unknown, tool: string, connectorName: string): unknown {
    // The platform refused, not the provider: the scope is named, the request is not (#642).
    if (e instanceof ConnectorNetworkError) return new ConnectorToolError(`Permission denied: ${e.message}.`, tool, e.code, { cause: e });
    if (e instanceof ConduitAuthError && e.needsReauth) {
        return new ConnectorToolError(
            `The ${connectorName} account this connector uses needs to be reconnected: its sign-in expired or was revoked. ` +
                `Ask the workspace owner to reconnect it (Reconnect on the connector's plugin page), then try again.`,
            tool,
            'needs_reauth',
            { cause: e }
        );
    }
    if (e instanceof ConduitValidationError) {
        return new ConnectorToolError(`Invalid arguments: ${issuesText(e.issues) || e.message}`, tool, e.code, { cause: e });
    }
    if (e instanceof ConduitRequestError) {
        const status = e.status === undefined ? '' : ` (HTTP ${e.status})`;
        const fields = e.issues?.length ? ` — ${issuesText(e.issues)}` : '';
        const retry = e.retryable ? ' It may work if tried again later.' : '';
        return new ConnectorToolError(`${connectorName} refused the call${status}: ${e.message}${fields}.${retry}`, tool, e.code, { cause: e });
    }
    if (e instanceof ConduitAuthError) return new ConnectorToolError(e.message, tool, e.code, { cause: e });
    return e;
}

/**
 * Open one connected account as tools. Throws when the account does not
 * exist, is not the owner's, or belongs to another connector — the platform
 * then leaves the connector out and tells the agent why. An account that
 * needs reconnecting still opens: each call says so instead.
 */
export async function conduitTools(engine: ConnectorEngine, options: ConduitToolsOptions): Promise<OpenedConduitConnector> {
    const { id, connector, account, owner } = options;
    const info = await engine.accounts.get(account, owner);
    if (!info) throw new Error(`[agentic connectors] connector "${id}": its ${connector} account is not connected (or not this workspace's)`);
    if (info.connector !== connector) throw new Error(`[agentic connectors] connector "${id}": account "${account}" is a ${info.connector} account, not ${connector}`);

    const spec = await engine.connectors.get(connector);
    const seen = new Map<string, string>();
    const tools: AnyTool[] = [];
    for (const op of spec.operations) {
        if (!isToolOperation(op)) continue;
        const name = connectorToolName(id, op.id);
        const other = seen.get(name);
        if (other !== undefined) throw new Error(`[agentic connectors] operations "${other}" and "${op.id}" of ${connector} both map to the tool "${name}"`);
        seen.set(name, op.id);
        const schema = operationInputSchema(op.inputs);
        const annotations = operationAnnotations(op);
        tools.push(
            defineTool({
                name,
                description: op.description ? `${op.label}. ${op.description}` : op.label,
                input: argumentsSchema(schema),
                jsonSchema: schema,
                ...(annotations ? { annotations } : {}),
                execute: async (input, ctx) => {
                    try {
                        const result = await engine.execute({ connector, operation: op.id, account, owner, inputs: input, signal: ctx.signal });
                        return result.output;
                    } catch (e) {
                        throw toolError(e, name, spec.name);
                    }
                }
            })
        );
    }
    return {
        tools,
        toolNames: tools.map((t) => t.name),
        // The engine is the workspace's and outlives the session: nothing to release per open.
        close: async () => undefined
    };
}
