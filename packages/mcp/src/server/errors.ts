/**
 * Errors the orchestration surface reports to a client. Both surface as
 * an MCP tool result with `isError: true` (the harness maps a thrown error
 * to one), so the model sees the reason and can act on it: ask for the
 * scope, or stop calling something that does not exist yet.
 */
import type { Scope } from '@agentic/core';

/** The client's grant lacks the tool family's scope. */
export class McpScopeError extends Error {
    override readonly name = 'McpScopeError';
    constructor(
        readonly tool: string,
        readonly scope: Scope
    ) {
        super(`forbidden: "${tool}" needs the "${scope}" scope, which this client was not granted — re-authorize with scope "${scope}"`);
    }
}

/** A declared tool whose implementation has not landed; the reason names the issue. */
export class McpUnsupportedError extends Error {
    override readonly name = 'McpUnsupportedError';
    constructor(
        readonly tool: string,
        readonly reason: string
    ) {
        super(`unsupported: "${tool}" — ${reason}`);
    }
}
