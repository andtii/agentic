/** Platform → daemon frames, one schema per kind plus the union. */

import { DAEMON_PROTOCOL_VERSION } from '@agentic/core';
import { z } from 'zod';
import type { PlatformFrame, PlatformFrameOf, PlatformFrameType } from '../frames.js';
import { cursors, environmentId, environmentInput, fsOp, machinePolicyInput, name, nonNegativeInt, openSpec, platformCursor, releaseAsset, sessionId, text } from './common.js';
import { wireCommand } from './wire.js';
import { LIMITS } from './limits.js';

const v = z.literal(DAEMON_PROTOCOL_VERSION);

const welcome = z.object({
    v,
    t: z.literal('welcome'),
    serverTime: nonNegativeInt,
    wanted: cursors,
    platform: z.object({ version: name, minDaemonVersion: name.optional(), latest: z.object({ stable: name.optional(), latest: name.optional() }).optional() }).optional()
});
const sessionOpen = z.object({ v, t: z.literal('session.open'), sessionId, environmentId, spec: openSpec });
const sessionCommand = z.object({ v, t: z.literal('session.command'), sessionId, command: wireCommand });
const sessionClose = z.object({ v, t: z.literal('session.close'), sessionId });
const toolResult = z
    .object({ v, t: z.literal('tool.result'), callId: name, output: z.unknown().optional(), error: z.object({ code: name, message: text }).optional() })
    .refine((f) => f.output === undefined || f.error === undefined, { message: 'tool.result carries output or error, not both', path: ['error'] })
    .refine((f) => f.output !== undefined || f.error !== undefined, { message: 'tool.result carries output or error (a void tool sends output: null)', path: ['output'] });
const ping = z.object({ v, t: z.literal('ping') });
const fsRequest = z.object({ v, t: z.literal('fs.request'), requestId: name, environmentId, op: fsOp });
/** `op` decides what else the frame carries. The frame strips unknown keys like every other; `environmentInput` is the strict part. */
const envRequest = z.discriminatedUnion('op', [
    z.object({ v, t: z.literal('env.request'), requestId: name, op: z.literal('put'), environment: environmentInput }),
    z.object({ v, t: z.literal('env.request'), requestId: name, op: z.literal('remove'), environmentId })
]);
/** A history slice (#397): `from` may be platform-stamped (fractional), `to` and `limit` bound the answer. */
const historyRequest = z.object({ v, t: z.literal('history.request'), requestId: name, sessionId, from: platformCursor, to: platformCursor.optional(), limit: z.number().int().min(1).max(LIMITS.list).optional() });
/**
 * Update and harness requests (#359, #360). `target` is a strict `ReleaseAsset` (an `https:` URL and a 64-hex digest) or,
 * for an update, the literal `'previous'`; a drain waits at most `LIMITS.drainTimeoutMs`.
 */
const mode = z.enum(['drain', 'now']);
const updateRequest = z.object({ v, t: z.literal('update.request'), requestId: name, target: z.union([releaseAsset, z.literal('previous'), z.literal('restart')]), mode, drainTimeoutMs: nonNegativeInt.max(LIMITS.drainTimeoutMs) });
const updateCancel = z.object({ v, t: z.literal('update.cancel'), requestId: name });
const harnessRequest = z.object({ v, t: z.literal('harness.request'), requestId: name, op: z.enum(['install', 'update', 'remove']), runtime: name, target: releaseAsset.optional(), mode });
/**
 * The web sets a machine's policy or browses its folders (#355). `op` decides what else the frame carries; the
 * `set` input is the strict part (a key the contract does not name fails the frame).
 */
const policyRequest = z.discriminatedUnion('op', [
    z.object({ v, t: z.literal('policy.request'), requestId: name, op: z.literal('set'), policy: machinePolicyInput }),
    z.object({ v, t: z.literal('policy.request'), requestId: name, op: z.literal('browse'), path: text.min(1).optional() })
]);
const logRequest = z.object({ v, t: z.literal('log.request'), requestId: name, lines: z.number().int().min(1).max(LIMITS.logLines) });
const loginRequest = z.object({ v, t: z.literal('login.request'), requestId: name, environmentId });
/** The pasted text of a relayed sign-in (#355): bounded, and nothing else on the frame. */
const loginAnswer = z.object({ v, t: z.literal('login.answer'), requestId: name, text: z.string().min(1).max(LIMITS.loginAnswer) });
const loginCancel = z.object({ v, t: z.literal('login.cancel'), requestId: name });

export const welcomeFrame: z.ZodType<PlatformFrameOf<'welcome'>> = welcome;
export const sessionOpenFrame: z.ZodType<PlatformFrameOf<'session.open'>> = sessionOpen;
export const sessionCommandFrame: z.ZodType<PlatformFrameOf<'session.command'>> = sessionCommand;
export const sessionCloseFrame: z.ZodType<PlatformFrameOf<'session.close'>> = sessionClose;
export const toolResultFrame: z.ZodType<PlatformFrameOf<'tool.result'>> = toolResult;
export const pingFrame: z.ZodType<PlatformFrameOf<'ping'>> = ping;
export const fsRequestFrame: z.ZodType<PlatformFrameOf<'fs.request'>> = fsRequest;
export const envRequestFrame: z.ZodType<PlatformFrameOf<'env.request'>> = envRequest;
export const historyRequestFrame: z.ZodType<PlatformFrameOf<'history.request'>> = historyRequest;
export const updateRequestFrame: z.ZodType<PlatformFrameOf<'update.request'>> = updateRequest;
export const updateCancelFrame: z.ZodType<PlatformFrameOf<'update.cancel'>> = updateCancel;
export const harnessRequestFrame: z.ZodType<PlatformFrameOf<'harness.request'>> = harnessRequest;
export const policyRequestFrame: z.ZodType<PlatformFrameOf<'policy.request'>> = policyRequest;
export const logRequestFrame: z.ZodType<PlatformFrameOf<'log.request'>> = logRequest;
export const loginRequestFrame: z.ZodType<PlatformFrameOf<'login.request'>> = loginRequest;
export const loginAnswerFrame: z.ZodType<PlatformFrameOf<'login.answer'>> = loginAnswer;
export const loginCancelFrame: z.ZodType<PlatformFrameOf<'login.cancel'>> = loginCancel;

/** Every platform frame kind by its `t`. */
export const platformFrameSchemas: { readonly [T in PlatformFrameType]: z.ZodType<PlatformFrameOf<T>> } = {
    welcome: welcomeFrame,
    'session.open': sessionOpenFrame,
    'session.command': sessionCommandFrame,
    'session.close': sessionCloseFrame,
    'tool.result': toolResultFrame,
    ping: pingFrame,
    'fs.request': fsRequestFrame,
    'env.request': envRequestFrame,
    'history.request': historyRequestFrame,
    'update.request': updateRequestFrame,
    'update.cancel': updateCancelFrame,
    'harness.request': harnessRequestFrame,
    'policy.request': policyRequestFrame,
    'log.request': logRequestFrame,
    'login.request': loginRequestFrame,
    'login.answer': loginAnswerFrame,
    'login.cancel': loginCancelFrame
};

export const platformFrame: z.ZodType<PlatformFrame> = z.union([welcome, sessionOpen, sessionCommand, sessionClose, toolResult, ping, fsRequest, envRequest, historyRequest, updateRequest, updateCancel, harnessRequest, policyRequest, logRequest, loginRequest, loginAnswer, loginCancel]);
