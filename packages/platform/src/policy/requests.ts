/**
 * Approval requests and session grants as views over a session's event log
 * (OPS-02, CHT-09, AC-12). The log is the record: a `request` event is an
 * open question until its `request-resolved` arrives, and a `session`-scoped
 * allow is a grant that lives until the session closes. Everything here is
 * pure over the events, so the Session actor, the inbox page and the tests
 * read the same shapes.
 *
 * Revoking a grant is NOT offered: `@sigx/ai-agent`'s `AgentSession` keeps
 * its `SessionGrants` private (a grant is checked before the policy runs,
 * so no policy of ours can undo one), and a daemon-hosted harness keeps
 * them in its own memory. The list is honest about what is granted; a
 * revoke control is not rendered (AC-15) until an adapter exposes them.
 */

import type { ApprovalRule } from '@agentic/core';
import type { AgentEvent, AgentTranscript, PolicyRequest, ToolAnnotations } from '@sigx/ai-agent';

import { ruleMatches } from './compile.js';

export type RequestEvent = Extract<AgentEvent, { type: 'request' }>;
export type RequestResolvedEvent = Extract<AgentEvent, { type: 'request-resolved' }>;

/** The two notification / status kinds a request maps to: a permission needs an approval, an input request an answer. */
export type RequestNeed = 'approval' | 'input';

export const needOf = (kind: RequestEvent['kind']): RequestNeed => (kind === 'permission' ? 'approval' : 'input');

/** The `ref` a chat status entry carries for a request, on both `request` and `request-resolved`. */
export const requestRef = (request: Pick<RequestEvent, 'kind' | 'requestId'>): string => `${needOf(request.kind)}:${request.requestId}`;

/** `approval:{id}` / `input:{id}` → its parts, or `null` for any other ref. */
export function parseRequestRef(ref: string | undefined): { readonly need: RequestNeed; readonly requestId: string } | null {
    if (!ref) return null;
    const i = ref.indexOf(':');
    if (i <= 0) return null;
    const need = ref.slice(0, i);
    const requestId = ref.slice(i + 1);
    if ((need !== 'approval' && need !== 'input') || !requestId) return null;
    return { need, requestId };
}

/** The key a session-scoped grant is remembered under: the adapter's `permissionKey`, else `tool:<name>` (what `mockAgent` and `modelAgent` default to). */
export const permissionKeyOf = (request: Pick<RequestEvent, 'permissionKey' | 'toolName'>): string | undefined => request.permissionKey ?? (request.toolName ? `tool:${request.toolName}` : undefined);

/** A `session`-scoped allow in force: who granted it, for which request, under which key. */
export interface SessionGrant {
    readonly permissionKey: string;
    readonly toolName?: string;
    readonly requestId: string;
    /** The wire's `ResolvedBy`: `client` for a person, `policy` for a rule. */
    readonly by: RequestResolvedEvent['by'];
    readonly ruleId?: string;
    readonly at: number;
}

/** Every session-scoped grant the log records, oldest first, one per key (a later grant of the same key replaces the earlier). */
export function sessionGrantsOf(events: readonly AgentEvent[]): SessionGrant[] {
    const requests = new Map<string, RequestEvent>();
    const grants = new Map<string, SessionGrant>();
    for (const ev of events) {
        if (ev.type === 'request') {
            if (ev.kind === 'permission') requests.set(ev.requestId, ev);
            continue;
        }
        if (ev.type !== 'request-resolved' || ev.outcome !== 'allow' || ev.scope !== 'session') continue;
        const request = requests.get(ev.requestId);
        const permissionKey = ev.permissionKey ?? (request ? permissionKeyOf(request) : undefined);
        if (!permissionKey) continue;
        grants.delete(permissionKey);
        grants.set(permissionKey, {
            permissionKey,
            ...(request?.toolName ? { toolName: request.toolName } : {}),
            requestId: ev.requestId,
            by: ev.by,
            ...(ev.ruleId ? { ruleId: ev.ruleId } : {}),
            at: ev.at
        });
    }
    return [...grants.values()];
}

/** One request as a client renders it: the question, the call it is about when the log has it, and the decision once there is one. */
export interface RequestRecord {
    readonly request: RequestEvent;
    /** The tool call's input, from the transcript snapshot or the live events. */
    readonly input?: unknown;
    /** The call's category and annotations (`tool-call`), what a rule matched on. */
    readonly category?: string;
    readonly annotations?: ToolAnnotations;
    readonly resolved?: RequestResolvedEvent;
}

/** The record of `requestId`, or `null` when the log has no such request. */
export function requestRecordOf(events: readonly AgentEvent[], requestId: string, transcript?: AgentTranscript): RequestRecord | null {
    let request: RequestEvent | undefined;
    let resolved: RequestResolvedEvent | undefined;
    for (const ev of events) {
        if (ev.type === 'request' && ev.requestId === requestId) request = ev;
        else if (ev.type === 'request-resolved' && ev.requestId === requestId) resolved = ev;
    }
    if (!request) return null;
    const call = request.callId ? callOf(events, request.callId) : undefined;
    const input = call?.input ?? (request.callId ? callInputOf(transcript, request.callId) : undefined);
    return {
        request,
        ...(input !== undefined ? { input } : {}),
        ...(call?.category !== undefined ? { category: call.category } : {}),
        ...(call?.annotations ? { annotations: call.annotations } : {}),
        ...(resolved ? { resolved } : {})
    };
}

/** The `PolicyRequest` a record's rule is looked up with (`ruleFor`); the source is not on the log, so a rule matching on it never claims the record. */
export function policyRequestOf(record: RequestRecord): PolicyRequest {
    const r = record.request;
    return {
        kind: r.kind,
        source: 'client',
        ...(r.callId ? { callId: r.callId } : {}),
        ...(r.toolName ? { toolName: r.toolName } : {}),
        ...(record.input !== undefined ? { input: record.input } : {}),
        ...(record.category !== undefined ? { category: record.category } : {}),
        ...(record.annotations ? { annotations: record.annotations } : {}),
        ...(r.message ? { message: r.message } : {}),
        ...(r.permissionKey ? { permissionKey: r.permissionKey } : {})
    };
}

/** Every request in the log, oldest first, open ones without a `resolved`. */
export function requestRecordsOf(events: readonly AgentEvent[], transcript?: AgentTranscript): RequestRecord[] {
    const out: RequestRecord[] = [];
    for (const ev of events) if (ev.type === 'request') out.push(requestRecordOf(events, ev.requestId, transcript)!);
    return out;
}

function callOf(events: readonly AgentEvent[], callId: string): Extract<AgentEvent, { type: 'tool-call' }> | undefined {
    for (const ev of events) if (ev.type === 'tool-call' && ev.callId === callId) return ev;
    return undefined;
}

function callInputOf(transcript: AgentTranscript | undefined, callId: string): unknown {
    if (!transcript) return undefined;
    for (const m of transcript.messages) for (const p of m.parts) if (p.type === 'tool' && p.callId === callId && p.input !== undefined) return p.input;
    return undefined;
}

/** The first rule of `rules` that covers `request` — the one `compilePolicy` would decide by. */
export function ruleFor(rules: readonly ApprovalRule[], request: PolicyRequest): ApprovalRule | undefined {
    return rules.find((rule) => ruleMatches(rule, request));
}

/** A rule as the approval card names it: `ask on destructive`, `deny Bash`, `allow mcp for session`. */
export function describeRule(rule: ApprovalRule): string {
    const m = rule.match;
    const what = m.tools?.length ? m.tools.join(', ') : m.categories?.length ? m.categories.join(', ') : m.source ? `${m.source} tools` : 'everything';
    const on = m.categories?.length && !m.tools?.length ? ' on ' : ' ';
    return `${rule.outcome}${on}${what}${rule.scope === 'session' ? ' for session' : ''}`.replace(/\s+/g, ' ').trim();
}

/**
 * An input decision's `answers` fitted to the request's form. A request that
 * carries a `schema` (Claude Code's `AskUserQuestion`: one property per
 * question, `q1`, `q2`, …) is answered with an object keyed by those
 * properties; the adapter reads nothing else and reports "The user did not
 * answer the questions." for a bare string. A client that sends one line of
 * free text (a phone, an older card) still gets through: the text answers
 * every question — an array for a multi-select. Anything already an object,
 * and every answer to a request without a form, is left as it is.
 */
export function shapeAnswers(schema: unknown, answers: unknown): unknown {
    if (typeof answers !== 'string') return answers;
    const properties = (schema as { properties?: unknown } | undefined)?.properties;
    if (!properties || typeof properties !== 'object') return answers;
    const keys = Object.keys(properties);
    if (keys.length === 0) return answers;
    const shaped: Record<string, unknown> = {};
    for (const key of keys) {
        const type = (properties as Record<string, { type?: unknown } | undefined>)[key]?.type;
        shaped[key] = type === 'array' ? [answers] : answers;
    }
    return shaped;
}
