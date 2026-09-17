/**
 * What the client needs from a transport — request/response plus fire-and-
 * forget notifications. Requests the SERVER initiates (sampling, elicitation,
 * roots) are the transport's business: each one is answered with
 * `METHOD_NOT_FOUND`, never dropped, and reported through `onServerMessage`
 * so a host can log what the server asked for (PLG-09).
 */

import type { JsonRpcId } from './protocol.js';

export interface McpRequestOptions {
    readonly signal?: AbortSignal;
}

/** A server-initiated request (has `id`; answered -32601) or a notification the client does not consume. */
export interface McpServerMessage {
    readonly method: string;
    readonly params?: unknown;
    readonly id?: JsonRpcId;
}

export interface McpTransport {
    request<R = unknown>(method: string, params?: unknown, options?: McpRequestOptions): Promise<R>;
    notify(method: string, params?: unknown): Promise<void>;
    /** Subscribe to server-initiated messages; returns the unsubscribe function. */
    onServerMessage(handler: (message: McpServerMessage) => void): () => void;
    close(): Promise<void>;
}

/** Notifications the client understands and keeps to itself; anything else is reported as unsupported. */
export const CONSUMED_NOTIFICATIONS: readonly string[] = ['notifications/progress', 'notifications/message'];
