/**
 * Agent tokens — how a minted agent principal is CARRIED to a tool callback.
 *
 * Two carriers, one identity:
 *
 * - **Over the wire** (a daemon relaying a runtime's tool call back to the
 *   platform): `Authorization: Bearer agt.…`, a sealed agent principal that
 *   `authenticate` opens. Short-lived and bound to one session.
 * - **In process** (a task body driving `modelAgent` inside the Session
 *   actor): detached task bodies inherit no principal by design, so the
 *   caller hands the identity in explicitly —
 *   `actor(Def, key).with({ context: asPrincipal(principal) })` — and the
 *   pipeline seeds it through `setPrincipal` without running `authenticate`.
 */
import type { Principal } from '@agentic/core';
import { setPrincipal } from '@sigx/server/server';
import { isPrincipal } from './principal.js';
import { open, seal, type SealedPayload } from './seal.js';

export const AGENT_TOKEN_PREFIX = 'agt.';
/** A session's tool callbacks outlive a turn, not a day. */
export const AGENT_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

interface AgentTokenPayload extends SealedPayload {
    readonly p: Principal;
}

export interface AgentTokenOptions {
    now?: number;
    ttlMs?: number;
}

/** Seal an agent principal as a bearer token. */
export function sealAgentToken(principal: Principal & { kind: 'agent' }, secret: string, options: AgentTokenOptions = {}): Promise<string> {
    const now = options.now ?? Date.now();
    return seal('agt', { p: principal, exp: now + (options.ttlMs ?? AGENT_TOKEN_TTL_MS) }, secret);
}

/** The agent principal a bearer token carries, or `null`. */
export async function openAgentToken(token: string | null | undefined, secret: string, now: number = Date.now()): Promise<(Principal & { kind: 'agent' }) | null> {
    const payload = await open<AgentTokenPayload>('agt', token, secret, now);
    if (!payload || !isPrincipal(payload.p) || payload.p.kind !== 'agent') return null;
    return payload.p;
}

/**
 * A server context that already carries `principal` — for in-process actor
 * calls from places with no request (task bodies, reminders, scripts):
 *
 * ```ts
 * await actor(Chat, key).with({ context: asPrincipal(agent) }).post(input);
 * ```
 */
export function asPrincipal(principal: Principal): { locals: Record<string, unknown> } {
    const context = { locals: {} as Record<string, unknown> };
    setPrincipal(context, principal);
    return context;
}
