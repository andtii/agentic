/**
 * The `@sigx/ai-agent/wire` envelope as schemas. The library ships shape
 * checks (`isWireFrame`, `isWireCommand`) that route; these validate what a
 * session frame, reply or command must carry before the daemon or the
 * platform acts on it. Session events and prompt parts are checked to the
 * depth the wire contract fixes; their payloads are the runtime's business.
 */

import { RESOURCE_TEXT_MAX_CHARS } from '@agentic/core';
import type { AgentCapabilities, AgentEvent, Decision, PromptPart, SessionRef } from '@sigx/ai-agent';
import { isAgentEvent } from '@sigx/ai-agent';
import type { WireCommand, WireFrame, WireOutputSpec, WireReply } from '@sigx/ai-agent/wire';
import { WIRE_PROTOCOL_VERSION } from '@sigx/ai-agent/wire';
import { z } from 'zod';
import { cursor, isRecord, name, nonNegativeInt, text } from './common.js';
import { LIMITS } from './limits.js';

const wireVersion = z.literal(WIRE_PROTOCOL_VERSION);

export const sessionRef: z.ZodType<SessionRef> = z.object({ agent: name, v: nonNegativeInt, id: name, data: z.unknown().optional() });

export const agentCapabilities: z.ZodType<AgentCapabilities> = z.object({
    resume: z.union([z.literal('portable'), z.literal('local'), z.literal(false)]),
    fork: z.boolean(),
    cancel: z.boolean(),
    steer: z.boolean(),
    config: z.boolean(),
    structuredOutput: z.boolean(),
    promptParts: z.enum(['text', 'text+image', 'text+image+file']),
    tools: z.enum(['native', 'mcp', 'none']),
    permissions: z.enum(['every-call', 'harness-filtered', 'none']),
    streamingToolInput: z.boolean(),
    importTranscript: z.boolean(),
    listSessions: z.boolean(),
    subagents: z.enum(['none', 'observe', 'control']),
    defineAgents: z.boolean()
});

/** A stamped event: `type`, `sessionId`, `epoch`, `seq` — what replay and routing need. */
export const agentEvent: z.ZodType<AgentEvent> = z.custom<AgentEvent>(isAgentEvent, { message: 'expected a stamped agent event (type, sessionId, epoch, seq)' });

const PART_TYPES: ReadonlySet<string> = new Set(['text', 'image', 'file', 'resource']);
const DECISION_TYPES: ReadonlySet<string> = new Set(['permission', 'input', 'cancel']);

function isPromptPart(p: unknown): p is PromptPart {
    if (!isRecord(p) || typeof p.type !== 'string' || !PART_TYPES.has(p.type)) return false;
    switch (p.type) {
        case 'text':
            return typeof p.text === 'string';
        case 'image':
        case 'file':
            return typeof p.mediaType === 'string' && (typeof p.data === 'string') !== (typeof p.url === 'string');
        default:
            // A resource may embed a bounded excerpt (#559: a diff hunk under an `agentic-session://` URI).
            return typeof p.uri === 'string' && (p.text === undefined || (typeof p.text === 'string' && p.text.length <= RESOURCE_TEXT_MAX_CHARS));
    }
}

export const promptPart: z.ZodType<PromptPart> = z.custom<PromptPart>(isPromptPart, {
    message: 'expected a prompt part (text with text; image/file with mediaType and one of data/url; resource with uri)'
});
export const decision: z.ZodType<Decision> = z.custom<Decision>((v) => isRecord(v) && typeof v.type === 'string' && DECISION_TYPES.has(v.type), {
    message: 'expected a permission, input or cancel decision'
});
export const outputSpec: z.ZodType<WireOutputSpec> = z.custom<WireOutputSpec>((v) => isRecord(v) && isRecord(v.schema) && (v.name === undefined || name.safeParse(v.name).success), {
    message: `expected { schema: JSON Schema, name? } with name 1-${LIMITS.id} chars`
});

/** One stamped event on the wire — what a `session.frame` streams and a `history.response` answers with (#397). */
export const wireEventFrame: z.ZodType<Extract<WireFrame, { readonly kind: 'event' }>> = z.object({ v: wireVersion, kind: z.literal('event'), epoch: nonNegativeInt, seq: nonNegativeInt, seqFrom: nonNegativeInt.optional(), event: agentEvent });

export const wireFrame: z.ZodType<WireFrame> = z.discriminatedUnion('kind', [
    z.object({ v: wireVersion, kind: z.literal('hello'), agentId: name, sessionId: name, sessionRef, capabilities: agentCapabilities, head: cursor }),
    z.object({ v: wireVersion, kind: z.literal('event'), epoch: nonNegativeInt, seq: nonNegativeInt, seqFrom: nonNegativeInt.optional(), event: agentEvent }),
    z.object({ v: wireVersion, kind: z.literal('gap'), from: cursor, resumeAt: cursor })
]);

export const wireReply: z.ZodType<WireReply> = z.discriminatedUnion('kind', [
    z.object({ v: wireVersion, kind: z.literal('ack'), commandId: name, turnId: name.optional() }),
    z.object({
        v: wireVersion,
        kind: z.literal('error'),
        commandId: name,
        code: z.enum(['unauthorized', 'busy', 'closed', 'invalid', 'unsupported', 'internal']),
        message: text
    })
]);

const configurePatch = z
    .record(name, z.string().max(LIMITS.text))
    .refine((r) => Object.keys(r).length <= LIMITS.list, { message: `at most ${LIMITS.list} patch keys` });

export const wireCommand: z.ZodType<WireCommand> = z.discriminatedUnion('type', [
    z.object({ v: wireVersion, commandId: name, type: z.literal('prompt'), turnId: name, input: z.array(promptPart).max(LIMITS.list), output: outputSpec.optional() }),
    z.object({ v: wireVersion, commandId: name, type: z.literal('respond'), requestId: name, decision }),
    z.object({ v: wireVersion, commandId: name, type: z.literal('cancel'), agentId: name.optional() }),
    z.object({ v: wireVersion, commandId: name, type: z.literal('configure'), patch: configurePatch }),
    z.object({ v: wireVersion, commandId: name, type: z.literal('close') })
]);
