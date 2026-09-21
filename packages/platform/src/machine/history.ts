/**
 * The Session's `HistorySource` over the Machine actor (#397): one
 * `historyRequest` — the `history.request` frame goes out to the daemon —
 * then the `historyAnswer` stream, which yields once the daemon's
 * `history.response` has landed in a later `socketMessage` turn (or the
 * request timed out). A fresh `actor()` call as the workspace user, never a
 * `ctx.actor` hop: it runs inside the Session's own turn, and the machine's
 * answer arrives on a turn of its own, so the hop must not inherit the
 * caller's chain. A machine that is offline, revoked or has no socket throws
 * (a `ServerFnError` from `historyRequest`), which the Session surfaces as
 * `history-unavailable`.
 */

import type { HistoryRange, SessionId, WorkspaceId } from '@agentic/core';
import { actor, type AnyActorDefinition } from '@sigx/actors';

import { asPrincipal, userPrincipal } from '../auth/index.js';
import type { HistoryAnswer, HistorySource } from '../session/ports.js';
import { machineKey } from './state.js';

interface HistoryClient {
    historyRequest(sessionId: SessionId, range: HistoryRange): Promise<{ readonly requestId: string }>;
    historyAnswer(requestId: string): AsyncIterable<HistoryAnswer>;
}

/** `defineSessionActor({ history: machineHistorySource(() => Machine) })` — the Machine definition as a thunk, since Session and Machine reference each other. */
export function machineHistorySource(machines: () => AnyActorDefinition): HistorySource {
    return {
        async fetch(target, range) {
            const workspaceId: WorkspaceId = target.workspaceId;
            const machine = actor(machines(), machineKey(workspaceId, target.machineId)).with({ context: asPrincipal(userPrincipal(workspaceId, workspaceId)) }) as unknown as HistoryClient;
            const { requestId } = await machine.historyRequest(target.sessionId, range);
            for await (const answer of machine.historyAnswer(requestId)) return answer;
            return { error: { code: 'internal', message: `machine ${target.machineId} gave no answer to history request ${requestId}` } };
        }
    };
}
