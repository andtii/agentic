/**
 * `memoryNeedsSource` — a `NeedsSource` over an in-memory, reactive store:
 * what the mock workspace renders and what the tests drive. It behaves
 * like the platform does: a decision lands on the request's record as
 * `resolved` (every card over it collapses to the same record) and the
 * notification is marked read, so the row leaves every list at once.
 */
import { signal } from 'sigx';
import type { AgentId, ChatId, SessionId, TaskId } from '@agentic/core';
import type { SessionRequestView } from '@agentic/platform';
import type { Decision } from '@sigx/ai-agent';
import { agentNamed, formatAge, MOCK_NOW, NEEDS, type MockNeedsItem } from '../../mock/workspace';
import type { NeedsRow, NeedsSource, RequestRef, RequestView } from './source';

export interface MemoryNeedsOptions {
    readonly rows: readonly NeedsRow[];
    /** The request views by request id. */
    readonly requests: Readonly<Record<string, RequestView>>;
    readonly now?: () => number;
    /** Intercept a decision — a test makes it fail. */
    readonly onRespond?: (ref: RequestRef, decision: Decision) => void | Promise<void>;
}

export interface MemoryNeedsSource extends NeedsSource {
    /** Every decision that got through, in order. */
    readonly decisions: readonly { readonly ref: RequestRef; readonly decision: Decision }[];
}

export function memoryNeedsSource(options: MemoryNeedsOptions): MemoryNeedsSource {
    const now = options.now ?? Date.now;
    const store = signal({ rows: [...options.rows] as NeedsRow[], requests: { ...options.requests } as Record<string, RequestView> });
    const decisions: { ref: RequestRef; decision: Decision }[] = [];
    return {
        decisions,
        useRows: () => () => store.rows,
        useRequest: (ref) => () => ({ loading: false, value: store.requests[ref.requestId] ?? null, error: null }),
        async respond(ref, decision) {
            const current = store.requests[ref.requestId];
            if (!current) throw new Error(`no request ${ref.requestId}`);
            if (current.view.resolved) return; // one decision per request: a late answer is a no-op ack
            await options.onRespond?.(ref, decision);
            decisions.push({ ref, decision });
            const at = now();
            const resolved: NonNullable<SessionRequestView['resolved']> =
                decision.type === 'permission'
                    ? { type: 'request-resolved', requestId: ref.requestId, outcome: decision.outcome, scope: decision.scope, by: 'client', at, sessionId: ref.sessionId, epoch: 1, seq: current.view.request.seq + 1 }
                    : decision.type === 'input'
                      ? { type: 'request-resolved', requestId: ref.requestId, outcome: 'input', answers: decision.answers, by: 'client', at, sessionId: ref.sessionId, epoch: 1, seq: current.view.request.seq + 1 }
                      : { type: 'request-resolved', requestId: ref.requestId, outcome: 'cancel', by: 'client', at, sessionId: ref.sessionId, epoch: 1, seq: current.view.request.seq + 1 };
            store.requests = { ...store.requests, [ref.requestId]: { ...current, view: { ...current.view, resolved } } };
            store.rows = store.rows.filter((r) => r.ref?.requestId !== ref.requestId);
        },
        age: (at) => formatAge(at, now())
    };
}

// ---- the mock workspace as a source -------------------------------------

const MOCK_SESSION: Record<string, SessionId> = { forge: 's1' as SessionId, scout: 's2' as SessionId };

/** The mock's input request: Scout's `ask_user` from the A2A landscape task. */
const SCOUT_ASK = { requestId: 'r_a2a1', message: 'Which A2A clients should the interop note cover?', taskId: 't2' as TaskId };

function mockRow(item: MockNeedsItem): NeedsRow {
    const agent = agentNamed(item.agentId);
    const requestId = item.request?.requestId ?? (item.kind === 'input' ? SCOUT_ASK.requestId : undefined);
    return {
        id: item.id,
        kind: item.kind,
        title: item.title,
        at: item.at,
        ...(requestId ? { ref: { sessionId: MOCK_SESSION[item.agentId] ?? ('s0' as SessionId), requestId } } : {}),
        agent: { name: agent.name, hue: agent.hue },
        context: item.context,
        ...(item.environment ? { environment: item.environment } : {}),
        href: item.href,
        hrefLabel: item.hrefLabel,
        ...(item.primary ? { primary: item.primary } : {})
    };
}

function mockRequests(): Record<string, RequestView> {
    const out: Record<string, RequestView> = {};
    for (const item of NEEDS) {
        const sessionId = MOCK_SESSION[item.agentId] ?? ('s0' as SessionId);
        const agent = agentNamed(item.agentId);
        if (item.kind === 'approval' && item.request && item.approval) {
            const r = item.request;
            out[r.requestId] = {
                view: {
                    sessionId,
                    agentId: item.agentId as AgentId,
                    chatId: 'c1' as ChatId,
                    ...(item.approval.rule ? { rule: item.approval.rule } : {}),
                    request: { type: 'request', requestId: r.requestId, kind: r.kind, sessionId, epoch: 1, seq: r.seq, ...(r.callId ? { callId: r.callId } : {}), ...(r.toolName ? { toolName: r.toolName } : {}), ...(r.message ? { message: r.message } : {}), ...(r.permissionKey ? { permissionKey: r.permissionKey } : {}) },
                    ...(item.approval.input !== undefined ? { input: item.approval.input } : {})
                },
                ...(item.approval.requestedBy ? { requestedBy: item.approval.requestedBy } : { requestedBy: { name: agent.name, hue: agent.hue } }),
                ...(item.approval.environment ? { environment: item.approval.environment } : {}),
                ...(item.approval.via ? { via: item.approval.via } : {})
            };
        } else if (item.kind === 'input') {
            out[SCOUT_ASK.requestId] = {
                view: {
                    sessionId,
                    agentId: item.agentId as AgentId,
                    taskId: SCOUT_ASK.taskId,
                    request: { type: 'request', requestId: SCOUT_ASK.requestId, kind: 'input', message: SCOUT_ASK.message, sessionId, epoch: 1, seq: 12 }
                },
                requestedBy: { name: agent.name, hue: agent.hue }
            };
        }
    }
    return out;
}

/** The design track's "Needs you": the artboards' three items over the mock workspace (`src/mock/workspace.ts`), answerable in memory. */
export function mockNeedsSource(): MemoryNeedsSource {
    return memoryNeedsSource({ rows: NEEDS.map(mockRow), requests: mockRequests(), now: () => MOCK_NOW });
}
