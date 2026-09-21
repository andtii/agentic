/** Daemon → platform frames, one schema per kind plus the union. */

import { DAEMON_PROTOCOL_VERSION, type DaemonFeature } from '@agentic/core';
import { z } from 'zod';
import type { DaemonFrame, DaemonFrameOf, DaemonFrameType } from '../frames.js';
import { capabilityReport, cursor, cursors, envError, environmentId, environments, envResult, fsError, fsResult, harnessReports, lifecycleError, machineId, machinePolicy, machineTelemetry, name, nonNegativeInt, os, quotaSnapshot, sessionId, text } from './common.js';
import { DAEMON_FEATURES, HARNESS_PHASES, SESSION_CLOSED_CODES, UPDATE_PHASES } from '../lifecycle.js';
import { LIMITS } from './limits.js';
import { sessionRef, wireEventFrame, wireFrame, wireReply } from './wire.js';

const v = z.literal(DAEMON_PROTOCOL_VERSION);

const isFeature = (f: string): f is DaemonFeature => (DAEMON_FEATURES as readonly string[]).includes(f);
/**
 * The optional frame families a daemon answers (#360): at most `LIMITS.harnesses` names, and one this end does not know
 * is dropped rather than failing the `hello` — a newer daemon must still pair with an older platform, which then simply
 * never sends it that family.
 */
const features = z
    .array(name)
    .max(LIMITS.harnesses)
    .transform((fs) => fs.filter(isFeature));
/** A build as the daemon reports it (#359): `platform` is the release asset key (`platformKey`), e.g. `win32-x64`. */
const build = z.object({ version: name, commit: name, protocol: nonNegativeInt, channel: name, platform: name });
/** A failed update or harness change names its error; nothing else carries one. */
const failedHasError = (f: { readonly phase: string; readonly error?: unknown }) => (f.phase === 'failed') === (f.error !== undefined);

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
    build: build.optional(),
    features: features.optional(),
    restarts: nonNegativeInt.optional(),
    lastExit: z.object({ at: nonNegativeInt, reason: text, code: z.number().int().optional() }).optional(),
    lastUpdate: z.object({ from: name, to: name, outcome: z.enum(['applied', 'rolled-back']), at: nonNegativeInt, error: text.optional() }).optional(),
    harnesses: harnessReports.optional()
});
const env = z.object({ v, t: z.literal('env'), environments, policy: machinePolicy.optional() });
const heartbeat = z.object({ v, t: z.literal('heartbeat'), at: nonNegativeInt, active: z.array(sessionId).max(LIMITS.list) });
const sessionOpened = z.object({ v, t: z.literal('session.opened'), sessionId, ref: sessionRef, capabilities: capabilityReport, head: cursor });
const sessionNamed = z.object({ v, t: z.literal('session.ref'), sessionId, ref: sessionRef });
const sessionTitled = z.object({ v, t: z.literal('session.title'), sessionId, title: text.refine((s) => s.trim().length > 0, { message: 'a title has words' }) });
const sessionFrame = z.object({ v, t: z.literal('session.frame'), sessionId, frame: wireFrame });
const sessionReply = z.object({ v, t: z.literal('session.reply'), sessionId, reply: wireReply });
const sessionClosed = z.object({
    v,
    t: z.literal('session.closed'),
    sessionId,
    reason: text,
    code: z.enum(SESSION_CLOSED_CODES).optional()
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
const telemetry = z.object({ v, t: z.literal('telemetry'), snapshot: machineTelemetry });
/** The events of a history slice (#397): at most `LIMITS.list`, and named errors — a `gap` may say how far back the log still reaches. */
const historyResult = z.object({ events: z.array(wireEventFrame).max(LIMITS.list), more: z.boolean().optional() });
const historyError = z.object({ code: z.enum(['unknown-session', 'gap', 'internal']), message: text, earliest: cursor.optional() });
const historyResponse = z
    .object({ v, t: z.literal('history.response'), requestId: name, result: historyResult.optional(), error: historyError.optional() })
    .refine((f) => f.result === undefined || f.error === undefined, { message: 'history.response carries result or error, not both', path: ['error'] })
    .refine((f) => f.result !== undefined || f.error !== undefined, { message: 'history.response carries result or error', path: ['result'] });
/** Update and harness progress (#359, #360): `progress` never passes its total, and `error` comes with `failed` and only then. */
const updateStatus = z
    .object({
        v,
        t: z.literal('update.status'),
        requestId: name,
        phase: z.enum(UPDATE_PHASES),
        progress: z
            .object({ bytes: nonNegativeInt, total: nonNegativeInt })
            .refine((p) => p.bytes <= p.total, { message: 'progress.bytes is at most progress.total', path: ['bytes'] })
            .optional(),
        error: lifecycleError.optional()
    })
    .refine(failedHasError, { message: 'update.status carries an error exactly when it failed', path: ['error'] });
const harnessStatus = z
    .object({ v, t: z.literal('harness.status'), requestId: name, phase: z.enum(HARNESS_PHASES), error: lifecycleError.optional() })
    .refine(failedHasError, { message: 'harness.status carries an error exactly when it failed', path: ['error'] });
const harnesses = z.object({ v, t: z.literal('harnesses'), harnesses: harnessReports });

export const helloFrame: z.ZodType<DaemonFrameOf<'hello'>> = hello;
export const envFrame: z.ZodType<DaemonFrameOf<'env'>> = env;
export const heartbeatFrame: z.ZodType<DaemonFrameOf<'heartbeat'>> = heartbeat;
export const sessionOpenedFrame: z.ZodType<DaemonFrameOf<'session.opened'>> = sessionOpened;
export const sessionRefFrame: z.ZodType<DaemonFrameOf<'session.ref'>> = sessionNamed;
export const sessionTitleFrame: z.ZodType<DaemonFrameOf<'session.title'>> = sessionTitled;
export const sessionFrameFrame: z.ZodType<DaemonFrameOf<'session.frame'>> = sessionFrame;
export const sessionReplyFrame: z.ZodType<DaemonFrameOf<'session.reply'>> = sessionReply;
export const sessionClosedFrame: z.ZodType<DaemonFrameOf<'session.closed'>> = sessionClosed;
export const toolCallFrame: z.ZodType<DaemonFrameOf<'tool.call'>> = toolCall;
export const pongFrame: z.ZodType<DaemonFrameOf<'pong'>> = pong;
export const fsResponseFrame: z.ZodType<DaemonFrameOf<'fs.response'>> = fsResponse;
export const envResponseFrame: z.ZodType<DaemonFrameOf<'env.response'>> = envResponse;
export const quotaFrame: z.ZodType<DaemonFrameOf<'quota'>> = quota;
export const telemetryFrame: z.ZodType<DaemonFrameOf<'telemetry'>> = telemetry;
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
    'session.title': sessionTitleFrame,
    'session.frame': sessionFrameFrame,
    'session.reply': sessionReplyFrame,
    'session.closed': sessionClosedFrame,
    'tool.call': toolCallFrame,
    pong: pongFrame,
    'fs.response': fsResponseFrame,
    'env.response': envResponseFrame,
    quota: quotaFrame,
    telemetry: telemetryFrame,
    'history.response': historyResponseFrame,
    'update.status': updateStatusFrame,
    'harness.status': harnessStatusFrame,
    harnesses: harnessesFrame
};

export const daemonFrame: z.ZodType<DaemonFrame> = z.discriminatedUnion('t', [hello, env, heartbeat, sessionOpened, sessionNamed, sessionTitled, sessionFrame, sessionReply, sessionClosed, toolCall, pong, fsResponse, envResponse, quota, telemetry, historyResponse, updateStatus, harnessStatus, harnesses]);
