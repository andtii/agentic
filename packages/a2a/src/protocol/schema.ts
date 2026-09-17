/**
 * Request validation for the server (spec §3.3.2: validate every parameter,
 * answer `-32602` naming the field). Unknown fields pass (spec §5.7).
 */

import { z } from 'zod';
import { A2A_ERROR, A2aError } from './errors.js';
import { TASK_STATES, type CancelTaskRequest, type GetTaskRequest, type JsonRpcRequest, type ListTasksRequest, type SendMessageRequest } from './types.js';

const metadata = z.record(z.string(), z.unknown()).optional();

const part = z
    .object({
        text: z.string().optional(),
        raw: z.string().optional(),
        url: z.string().optional(),
        data: z.unknown().optional(),
        metadata,
        filename: z.string().optional(),
        mediaType: z.string().optional()
    })
    .refine((p) => [p.text, p.raw, p.url, 'data' in p && p.data !== undefined].filter((x) => x !== undefined && x !== false).length === 1, {
        message: 'a part carries exactly one of text, raw, url, data'
    });

const message = z.object({
    messageId: z.string().min(1),
    contextId: z.string().min(1).optional(),
    taskId: z.string().min(1).optional(),
    role: z.enum(['ROLE_UNSPECIFIED', 'ROLE_USER', 'ROLE_AGENT']),
    parts: z.array(part).min(1),
    metadata,
    extensions: z.array(z.string()).optional(),
    referenceTaskIds: z.array(z.string()).optional()
});

const sendMessage = z.object({
    tenant: z.string().optional(),
    message,
    configuration: z
        .object({
            acceptedOutputModes: z.array(z.string()).optional(),
            historyLength: z.number().int().min(0).optional(),
            returnImmediately: z.boolean().optional(),
            taskPushNotificationConfig: z.unknown().optional()
        })
        .optional(),
    metadata
});

const getTask = z.object({ tenant: z.string().optional(), id: z.string().min(1), historyLength: z.number().int().min(0).optional() });

const listTasks = z.object({
    tenant: z.string().optional(),
    contextId: z.string().optional(),
    status: z.enum(TASK_STATES as [string, ...string[]]).optional(),
    pageSize: z.number().int().min(1).max(100).optional(),
    pageToken: z.string().optional(),
    historyLength: z.number().int().min(0).optional(),
    statusTimestampAfter: z.string().optional(),
    includeArtifacts: z.boolean().optional()
});

const cancelTask = z.object({ tenant: z.string().optional(), id: z.string().min(1), metadata });

const rpc = z.object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string(), z.number(), z.null()]).optional(),
    method: z.string().min(1),
    params: z.unknown().optional()
});

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
    const r = schema.safeParse(value ?? {});
    if (r.success) return r.data;
    const violations = r.error.issues.map((i) => ({ field: `${what}${i.path.length ? '.' + i.path.map(String).join('.') : ''}`, description: i.message }));
    throw new A2aError(A2A_ERROR.invalidParams, `Invalid parameters: ${violations.map((v) => `${v.field}: ${v.description}`).join('; ')}`, [
        { '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: violations }
    ]);
}

export function parseJsonRpcRequest(value: unknown): JsonRpcRequest {
    const r = rpc.safeParse(value);
    if (r.success) return r.data as JsonRpcRequest;
    throw new A2aError(A2A_ERROR.invalidRequest, `Request payload validation error: ${r.error.issues.map((i) => `${i.path.map(String).join('.') || 'request'}: ${i.message}`).join('; ')}`);
}

export const parseSendMessage = (params: unknown): SendMessageRequest => parse(sendMessage, params, 'params') as SendMessageRequest;
export const parseGetTask = (params: unknown): GetTaskRequest => parse(getTask, params, 'params');
export const parseListTasks = (params: unknown): ListTasksRequest => parse(listTasks, params, 'params') as ListTasksRequest;
export const parseCancelTask = (params: unknown): CancelTaskRequest => parse(cancelTask, params, 'params');
