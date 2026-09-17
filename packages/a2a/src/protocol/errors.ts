/** A2A error codes (spec §5.4, §9.5) and the one error class both sides throw. */

import type { JsonRpcErrorObject } from './types.js';

export const A2A_ERROR = {
    parse: -32700,
    invalidRequest: -32600,
    methodNotFound: -32601,
    invalidParams: -32602,
    internal: -32603,
    taskNotFound: -32001,
    taskNotCancelable: -32002,
    pushNotificationNotSupported: -32003,
    unsupportedOperation: -32004,
    contentTypeNotSupported: -32005,
    invalidAgentResponse: -32006,
    extendedAgentCardNotConfigured: -32007,
    extensionSupportRequired: -32008,
    versionNotSupported: -32009
} as const;

export type A2aErrorCode = (typeof A2A_ERROR)[keyof typeof A2A_ERROR];

const MESSAGES: Readonly<Record<number, string>> = {
    [-32700]: 'Invalid JSON payload',
    [-32600]: 'Request payload validation error',
    [-32601]: 'Method not found',
    [-32602]: 'Invalid parameters',
    [-32603]: 'Internal error',
    [-32001]: 'Task not found',
    [-32002]: 'Task cannot be canceled',
    [-32003]: 'Push notifications are not supported',
    [-32004]: 'This operation is not supported',
    [-32005]: 'Content type not supported',
    [-32006]: 'Invalid agent response',
    [-32007]: 'Extended agent card not configured',
    [-32008]: 'Extension support required',
    [-32009]: 'Protocol version not supported'
};

const REASONS: Readonly<Record<number, string>> = {
    [-32001]: 'TASK_NOT_FOUND',
    [-32002]: 'TASK_NOT_CANCELABLE',
    [-32003]: 'PUSH_NOTIFICATION_NOT_SUPPORTED',
    [-32004]: 'UNSUPPORTED_OPERATION',
    [-32005]: 'CONTENT_TYPE_NOT_SUPPORTED',
    [-32006]: 'INVALID_AGENT_RESPONSE',
    [-32007]: 'EXTENDED_AGENT_CARD_NOT_CONFIGURED',
    [-32008]: 'EXTENSION_SUPPORT_REQUIRED',
    [-32009]: 'VERSION_NOT_SUPPORTED'
};

/** An A2A error: thrown by the server (and turned into a JSON-RPC error) or by the client (from one). */
export class A2aError extends Error {
    override readonly name = 'A2aError';
    readonly code: number;
    readonly data: unknown;
    constructor(code: number, message?: string, data?: unknown) {
        super(message ?? MESSAGES[code] ?? `A2A error ${code}`);
        this.code = code;
        this.data = data;
    }

    /** The JSON-RPC `error` member, with a `google.rpc.ErrorInfo` detail for A2A-specific codes (spec §9.5). */
    toJSON(): JsonRpcErrorObject {
        if (this.data !== undefined) return { code: this.code, message: this.message, data: this.data };
        const reason = REASONS[this.code];
        return reason ? { code: this.code, message: this.message, data: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'a2a-protocol.org' }] } : { code: this.code, message: this.message };
    }
}

export function isA2aError(e: unknown): e is A2aError {
    return e instanceof A2aError;
}
