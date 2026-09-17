/**
 * The `agentic` A2A extension: how `@sigx/ai-agent` events that have no A2A
 * counterpart (tool calls, requests, usage, the turn result) travel as
 * `DataPart`s. A plain A2A peer ignores them — text and files are still plain
 * parts — while two agentic ends see the full turn. Declared on the card under
 * `capabilities.extensions` (`required: false`).
 */

import type { Decision } from '@sigx/ai-agent';
import type { A2aPart } from './types.js';

export const AGENTIC_EXTENSION_URI = 'https://github.com/andtii/agentic/a2a/agent-events/v1';

/** A `DataPart` whose `data` is an `@sigx/ai-agent` event payload (`{ type, … }`). */
export const EVENT_MEDIA_TYPE = 'application/vnd.agentic.agent-event+json';
/** A `DataPart` whose `data` is a `Decision` answering an `INPUT_REQUIRED` request. */
export const DECISION_MEDIA_TYPE = 'application/vnd.agentic.decision+json';

export type CarriedEvent = { readonly type: string } & Record<string, unknown>;

export function eventPart(event: CarriedEvent): A2aPart {
    return { data: event, mediaType: EVENT_MEDIA_TYPE };
}

export function decisionPart(decision: Decision): A2aPart {
    return { data: decision, mediaType: DECISION_MEDIA_TYPE };
}

/** The event carried by a part, or `undefined` for any other part. */
export function readEventPart(part: A2aPart): CarriedEvent | undefined {
    if (part.mediaType !== EVENT_MEDIA_TYPE) return undefined;
    const d = part.data;
    if (typeof d !== 'object' || d === null || typeof (d as { type?: unknown }).type !== 'string') return undefined;
    return d as CarriedEvent;
}

/** The decision carried by a part, or `undefined` for any other (or malformed) part. */
export function readDecisionPart(part: A2aPart): Decision | undefined {
    if (part.mediaType !== DECISION_MEDIA_TYPE) return undefined;
    const d = part.data as { type?: unknown } | null;
    if (typeof d !== 'object' || d === null) return undefined;
    if (d.type === 'cancel') return { type: 'cancel' };
    if (d.type === 'input') return { type: 'input', answers: (d as { answers?: unknown }).answers };
    if (d.type === 'permission') {
        const p = d as { outcome?: unknown; scope?: unknown; message?: unknown };
        if (p.outcome !== 'allow' && p.outcome !== 'deny') return undefined;
        return { type: 'permission', outcome: p.outcome, scope: p.scope === 'session' ? 'session' : 'once', ...(typeof p.message === 'string' ? { message: p.message } : {}) };
    }
    return undefined;
}
