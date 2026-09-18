/** Platform → daemon frames, one schema per kind plus the union. */

import { DAEMON_PROTOCOL_VERSION } from '@agentic/core';
import { z } from 'zod';
import type { PlatformFrame, PlatformFrameOf, PlatformFrameType } from '../frames.js';
import { cursors, environmentId, fsOp, name, nonNegativeInt, openSpec, sessionId, text } from './common.js';
import { wireCommand } from './wire.js';

const v = z.literal(DAEMON_PROTOCOL_VERSION);

const welcome = z.object({ v, t: z.literal('welcome'), serverTime: nonNegativeInt, wanted: cursors });
const sessionOpen = z.object({ v, t: z.literal('session.open'), sessionId, environmentId, spec: openSpec });
const sessionCommand = z.object({ v, t: z.literal('session.command'), sessionId, command: wireCommand });
const sessionClose = z.object({ v, t: z.literal('session.close'), sessionId });
const toolResult = z
    .object({ v, t: z.literal('tool.result'), callId: name, output: z.unknown().optional(), error: z.object({ code: name, message: text }).optional() })
    .refine((f) => f.output === undefined || f.error === undefined, { message: 'tool.result carries output or error, not both', path: ['error'] })
    .refine((f) => f.output !== undefined || f.error !== undefined, { message: 'tool.result carries output or error (a void tool sends output: null)', path: ['output'] });
const ping = z.object({ v, t: z.literal('ping') });
const fsRequest = z.object({ v, t: z.literal('fs.request'), requestId: name, environmentId, op: fsOp });

export const welcomeFrame: z.ZodType<PlatformFrameOf<'welcome'>> = welcome;
export const sessionOpenFrame: z.ZodType<PlatformFrameOf<'session.open'>> = sessionOpen;
export const sessionCommandFrame: z.ZodType<PlatformFrameOf<'session.command'>> = sessionCommand;
export const sessionCloseFrame: z.ZodType<PlatformFrameOf<'session.close'>> = sessionClose;
export const toolResultFrame: z.ZodType<PlatformFrameOf<'tool.result'>> = toolResult;
export const pingFrame: z.ZodType<PlatformFrameOf<'ping'>> = ping;
export const fsRequestFrame: z.ZodType<PlatformFrameOf<'fs.request'>> = fsRequest;

/** Every platform frame kind by its `t`. */
export const platformFrameSchemas: { readonly [T in PlatformFrameType]: z.ZodType<PlatformFrameOf<T>> } = {
    welcome: welcomeFrame,
    'session.open': sessionOpenFrame,
    'session.command': sessionCommandFrame,
    'session.close': sessionCloseFrame,
    'tool.result': toolResultFrame,
    ping: pingFrame,
    'fs.request': fsRequestFrame
};

export const platformFrame: z.ZodType<PlatformFrame> = z.union([welcome, sessionOpen, sessionCommand, sessionClose, toolResult, ping, fsRequest]);
