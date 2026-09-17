/**
 * JSON-over-WebSocket framing: one frame per text message. `decode*` takes
 * what a socket hands over (a string, an `ArrayBuffer` or a view), refuses
 * it before parsing when it is too large, then checks the version and the
 * kind before the schema runs, so a peer speaking another protocol version
 * is told so by name rather than by a pile of field errors. `encodeFrame`
 * refuses to produce a message the other end would drop.
 */

import { DAEMON_FRAME_TYPES, DAEMON_PROTOCOL_VERSION, PLATFORM_FRAME_TYPES } from '@agentic/core';
import type { z } from 'zod';
import type { AnyFrame, DaemonFrame, DaemonFrameType, PlatformFrame, PlatformFrameType } from '../frames.js';
import { daemonFrameSchemas } from '../schema/daemon.js';
import { LIMITS } from '../schema/limits.js';
import { platformFrameSchemas } from '../schema/platform.js';
import { DaemonProtocolError, type FrameError, type FrameIssue } from './errors.js';

/** What a WebSocket `message` event carries (a `Blob` must be read to one of these first). */
export type RawMessage = string | ArrayBuffer | ArrayBufferView;

export type DecodeResult<T> = { readonly ok: true; readonly frame: T } | { readonly ok: false; readonly error: FrameError };

export interface FramingOptions {
    /** Largest message accepted or produced, in UTF-8 bytes. Default `LIMITS.frameBytes`. */
    readonly maxBytes?: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** UTF-8 size of a message. */
export function frameBytes(raw: RawMessage): number {
    if (typeof raw === 'string') return encoder.encode(raw).byteLength;
    return raw.byteLength;
}

interface Side<T extends AnyFrame> {
    readonly types: ReadonlySet<string>;
    readonly what: string;
    schema(t: string): z.ZodType<T> | undefined;
}

const daemonSide: Side<DaemonFrame> = {
    types: new Set<string>(DAEMON_FRAME_TYPES),
    what: 'daemon frame',
    schema: (t) => daemonFrameSchemas[t as DaemonFrameType] as z.ZodType<DaemonFrame> | undefined
};
const platformSide: Side<PlatformFrame> = {
    types: new Set<string>(PLATFORM_FRAME_TYPES),
    what: 'platform frame',
    schema: (t) => platformFrameSchemas[t as PlatformFrameType] as z.ZodType<PlatformFrame> | undefined
};

const fail = (code: FrameError['code'], message: string, issues?: readonly FrameIssue[]): { ok: false; error: FrameError } => ({
    ok: false,
    error: issues ? { code, message, issues } : { code, message }
});

function parseSide<T extends AnyFrame>(side: Side<T>, value: unknown): DecodeResult<T> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail('not-object', `a ${side.what} is a JSON object`);
    const v = value as Record<string, unknown>;
    if (v.v !== DAEMON_PROTOCOL_VERSION) return fail('unsupported-version', `daemon protocol v${String(v.v)} is not supported; this end speaks v${DAEMON_PROTOCOL_VERSION}`);
    if (typeof v.t !== 'string' || !side.types.has(v.t)) return fail('unknown-type', `unknown ${side.what} type ${JSON.stringify(v.t)}`);
    const result = side.schema(v.t)!.safeParse(value);
    if (result.success) return { ok: true, frame: result.data };
    const issues = result.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));
    return fail('invalid', `invalid ${side.what} ${v.t}: ${issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ')}`, issues);
}

function decodeSide<T extends AnyFrame>(side: Side<T>, raw: RawMessage, options?: FramingOptions): DecodeResult<T> {
    const max = options?.maxBytes ?? LIMITS.frameBytes;
    const size = frameBytes(raw);
    if (size > max) return fail('too-large', `${side.what} of ${size} bytes exceeds the ${max} byte limit`);
    const text = typeof raw === 'string' ? raw : decoder.decode(raw);
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch (e) {
        return fail('not-json', `${side.what} is not JSON: ${(e as Error).message}`);
    }
    return parseSide(side, value);
}

/** Validate a daemon → platform frame that is already parsed JSON. */
export function parseDaemonFrame(value: unknown): DecodeResult<DaemonFrame> {
    return parseSide(daemonSide, value);
}

/** Validate a platform → daemon frame that is already parsed JSON. */
export function parsePlatformFrame(value: unknown): DecodeResult<PlatformFrame> {
    return parseSide(platformSide, value);
}

/** Decode a socket message from the daemon. */
export function decodeDaemonFrame(raw: RawMessage, options?: FramingOptions): DecodeResult<DaemonFrame> {
    return decodeSide(daemonSide, raw, options);
}

/** Decode a socket message from the platform. */
export function decodePlatformFrame(raw: RawMessage, options?: FramingOptions): DecodeResult<PlatformFrame> {
    return decodeSide(platformSide, raw, options);
}

/** One frame as one text message. Throws `DaemonProtocolError` (`too-large`) rather than send what the peer must drop. */
export function encodeFrame(frame: AnyFrame, options?: FramingOptions): string {
    const text = JSON.stringify(frame);
    const max = options?.maxBytes ?? LIMITS.frameBytes;
    const size = frameBytes(text);
    if (size > max) throw new DaemonProtocolError({ code: 'too-large', message: `${frame.t} frame of ${size} bytes exceeds the ${max} byte limit` });
    return text;
}
