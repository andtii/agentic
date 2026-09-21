/** Daemon → platform frames, one schema per kind plus the union. */

import { DAEMON_PROTOCOL_VERSION } from '@agentic/core';
import { z } from 'zod';
import type { DaemonFrame, DaemonFrameOf, DaemonFrameType } from '../frames.js';
import { capabilityReport, cursor, cursors, envError, environmentId, environments, envResult, fsError, fsResult, harnessReports, lifecycleError, machineId, machinePolicy, name, nonNegativeInt, os, quotaSnapshot, sessionId, text } from './common.js';
import { LIMITS } from './limits.js';
import { sessionRef, wireEventFrame, wireFrame, wireReply } from './wire.js';

const v = z.literal(DAEMON_PROTOCOL_VERSION);

const hello = z.object({
    v,
    t: z.literal('hello'),
    machineId,
    daemonVersion: name,
    os,
    environments,
    capabilities: z.array(capabilityReport).max(LIMITS.list),
    resume: cursors,
    policy: machinePolicy.optional(),
    // #359: build, features and lifecycle history; each optional, so an older daemon's hello still parses.
    build: z.object({ version: name, commit: name, protocol: nonNegativeInt, channel: name }).optional(),
    features: z.array(z.enum(['update', 'harness'])).max(LIMITS.list).optional(),
    restarts: nonNegativeInt.optional(),
    lastExit: z.object({ at: nonNegativeInt, reason: text, code: z.number().int().optional() }).optional(),
    lastUpdate: z.object({ from: name, to: name, outcome: z.enum(['applied', 'rolled-back']), at: nonNegativeInt, error: text.optional() }).optional(),
    harnesses: harnessReports.optional()
});
const env = z.object({ v, t: z.literal('env'), environments, policy: machinePolicy.optional() });
const heartbeat = z.object({ v, t: z.literal('heartbeat'), at: nonNegativeInt, active: z.array(sessionId).max(LIMITS.list) });
const sessionOpened = z.object({ v, t: z.literal('session.opened'), sessionId, ref: sessionRef, capabilities: capabilityReport, head: cursor });
const sessionNamed = z.object({ v, t: z.literal('session.ref'), sessionId, ref: sessionRef });
const sessionFrame = z.object({ v, t: z.literal('session.frame'), sessionId, frame: wireFrame });
const sessionReply = z.object({ v, t: z.literal('session.reply'), sessionId, reply: wireReply });
const sessionClosed = z.object({
    v,
    t: z.literal('session.closed'),
    sessionId,
    reason: text,
    code: z.enum(['restart', 'update', 'harness-update', 'draining', 'harness-missing', 'resume-failed']).optional()
});
const toolCall = z.object({ v, t: z.literal('tool.call'), callId: name, sessionId, tool: name, input: z.unknown() });
const pong = z.object({ v, t: z.literal('pong'), at: nonNegativeInt });
const fsResponse = z
    .object({ v, t: z.literal('fs.response'), requestId: name, result: fsResult.optional(), error: fsError.optional() })
    .refine((f) => f.result === undefined || f.error === undefined, { message: 'fs.response carries result or error, not both', path: ['error'] })
    .refine((f) => f.result !== undefined || f.error !== undefined, { message: 'fs.response carries result or error', path: ['result'] });
const envResponse = z
    .object({ v, t: z.literal('env.response'), requestId: name, result: envResult.optional(), error: envError.optional() })
    .refine((f) => f.result === undefined || f.error === undefined, { message: 'env.response carries result or error, not both', path: ['error'] })
    .refine((f) => f.result !== undefined || f.error !== undefined, { message: 'env.response carries result or error', path: ['result'] });
const quota = z
    .object({ v, t: z.literal('quota'), environmentId, snapshot: quotaSnapshot })
    .refine((f) => f.snapshot.environmentId === f.environmentId, { message: 'quota snapshot is for another environment', path: ['snapshot', 'environmentId'] });
/** The events of a history slice (#397): at most `LIMITS.list`, and named errors — a `gap` may say how far back the log still reaches. */
const historyResult = z.object({ events: z.array(wireEventFrame).max(LIMITS.list), more: z.boolean().optional() });
const historyError = z.object({ code: z.enum(['unknown-session', 'gap', 'internal']), message: text, earliest: cursor.optional() });
const historyResponse = z
    .object({ v, t: z.literal('history.response'), requestId: name, result: historyResult.optional(), error: historyError.optional() })
    .refine((f) => f.result === undefined || f.error === undefined, { message: 'history.response carries result or error, not both', path: ['error'] })
    .refine((f) => f.result !== undefined || f.error !== undefined, { message: 'history.response carries result or error', path: ['result'] });
/** Update and harness progress (#359); #360 hardens these. */
const updateStatus = z.object({
    v,
    t: z.literal('update.status'),
    requestId: name,
    phase: z.enum(['downloading', 'verifying', 'staged', 'draining', 'restarting', 'failed']),
    progress: z.object({ bytes: nonNegativeInt, total: nonNegativeInt }).optional(),
    error: lifecycleError.optional()
});
const harnessStatus = z.object({
    v,
    t: z.literal('harness.status'),
    requestId: name,
    phase: z.enum(['downloading', 'verifying', 'staged', 'draining', 'applying', 'done', 'failed']),
    error: lifecycleError.optional()
});
const harnesses = z.object({ v, t: z.literal('harnesses'), harnesses: harnessReports });

export const helloFrame: z.ZodType<DaemonFrameOf<'hello'>> = hello;
export const envFrame: z.ZodType<DaemonFrameOf<'env'>> = env;
export const heartbeatFrame: z.ZodType<DaemonFrameOf<'heartbeat'>> = heartbeat;
export const sessionOpenedFrame: z.ZodType<DaemonFrameOf<'session.opened'>> = sessionOpened;
export const sessionRefFrame: z.ZodType<DaemonFrameOf<'session.ref'>> = sessionNamed;
export const sessionFrameFrame: z.ZodType<DaemonFrameOf<'session.frame'>> = sessionFrame;
export const sessionReplyFrame: z.ZodType<DaemonFrameOf<'session.reply'>> = sessionReply;
export const sessionClosedFrame: z.ZodType<DaemonFrameOf<'session.closed'>> = sessionClosed;
export const toolCallFrame: z.ZodType<DaemonFrameOf<'tool.call'>> = toolCall;
export const pongFrame: z.ZodType<DaemonFrameOf<'pong'>> = pong;
export const fsResponseFrame: z.ZodType<DaemonFrameOf<'fs.response'>> = fsResponse;
export const envResponseFrame: z.ZodType<DaemonFrameOf<'env.response'>> = envResponse;
export const quotaFrame: z.ZodType<DaemonFrameOf<'quota'>> = quota;
export const historyResponseFrame: z.ZodType<DaemonFrameOf<'history.response'>> = historyResponse;
export const updateStatusFrame: z.ZodType<DaemonFrameOf<'update.status'>> = updateStatus;
export const harnessStatusFrame: z.ZodType<DaemonFrameOf<'harness.status'>> = harnessStatus;
export const harnessesFrame: z.ZodType<DaemonFrameOf<'harnesses'>> = harnesses;

/** Every daemon frame kind by its `t`. */
export const daemonFrameSchemas: { readonly [T in DaemonFrameType]: z.ZodType<DaemonFrameOf<T>> } = {
    hello: helloFrame,
    env: envFrame,
    heartbeat: heartbeatFrame,
    'session.opened': sessionOpenedFrame,
    'session.ref': sessionRefFrame,
    'session.frame': sessionFrameFrame,
    'session.reply': sessionReplyFrame,
    'session.closed': sessionClosedFrame,
    'tool.call': toolCallFrame,
    pong: pongFrame,
    'fs.response': fsResponseFrame,
    'env.response': envResponseFrame,
    quota: quotaFrame,
    'history.response': historyResponseFrame,
    'update.status': updateStatusFrame,
    'harness.status': harnessStatusFrame,
    harnesses: harnessesFrame
};

export const daemonFrame: z.ZodType<DaemonFrame> = z.discriminatedUnion('t', [hello, env, heartbeat, sessionOpened, sessionNamed, sessionFrame, sessionReply, sessionClosed, toolCall, pong, fsResponse, envResponse, quota, historyResponse, updateStatus, harnessStatus, harnesses]);
