/**
 * The named reasons of the daemon lifecycle (#360; OPS-05): why a host ended a session, which optional frame families a
 * daemon answers, the phases an update or a harness change reports, and the refusal a draining daemon gives a prompt.
 * The schemas are built from these lists, so a value the contract does not name fails the frame.
 */

import type { DaemonFeature, HarnessPhase, LoginPhase, SessionClosedCode, UpdatePhase } from '@agentic/core';
import { WIRE_PROTOCOL_VERSION, type WireReply } from '@sigx/ai-agent/wire';

/** Every `SessionClosedCode`, the `code` a `session.closed` may carry beside its human `reason`. */
export const SESSION_CLOSED_CODES = ['restart', 'update', 'harness-update', 'draining', 'harness-missing', 'resume-failed'] as const satisfies readonly SessionClosedCode[];

/** Every `DaemonFeature` a `hello.features` may list. */
export const DAEMON_FEATURES = ['update', 'harness', 'policy', 'log', 'login', 'files', 'run'] as const satisfies readonly DaemonFeature[];

/** `update.status` phases, in the order a successful update passes them (`failed` ends one early). */
export const UPDATE_PHASES = ['downloading', 'verifying', 'staged', 'draining', 'restarting', 'failed'] as const satisfies readonly UpdatePhase[];

/** `harness.status` phases, in the order a successful harness change passes them (`failed` ends one early). */
export const HARNESS_PHASES = ['downloading', 'verifying', 'staged', 'draining', 'applying', 'done', 'failed'] as const satisfies readonly HarnessPhase[];

/** `login.status` phases, in the order a relayed sign-in passes them (#355; `failed` ends one early). */
export const LOGIN_PHASES = ['started', 'action', 'waiting', 'done', 'failed'] as const satisfies readonly LoginPhase[];

// Each list names the whole union: a value core adds and these lack fails the typecheck here.
type Covers<U, L extends readonly unknown[]> = [Exclude<U, L[number]>] extends [never] ? true : never;
const covered: [Covers<SessionClosedCode, typeof SESSION_CLOSED_CODES>, Covers<DaemonFeature, typeof DAEMON_FEATURES>, Covers<UpdatePhase, typeof UPDATE_PHASES>, Covers<HarnessPhase, typeof HARNESS_PHASES>, Covers<LoginPhase, typeof LOGIN_PHASES>] = [true, true, true, true, true];
void covered;

/**
 * The wire error a draining daemon answers a turn-starting `prompt` with (#364, #369): no new turns while an update or
 * a harness change waits for the running ones, while a `session.open` is still accepted. The session wire's error codes
 * are `@sigx/ai-agent`'s and have no `draining`, so the refusal travels as `code: 'busy'` — the platform parks and
 * prompts again, exactly as it does for `busy` — with a message that starts `draining:`, which `isDrainingReply` reads.
 */
export const DRAINING = 'draining' as const;

/** The `session.reply` error for a prompt refused while draining; `detail` says what the daemon waits for. */
export function drainingReply(commandId: string, detail = 'the daemon is draining for an update'): WireReply {
    return { v: WIRE_PROTOCOL_VERSION, kind: 'error', commandId, code: 'busy', message: `${DRAINING}: ${detail}` };
}

/** Whether `reply` is a draining daemon's refusal (`drainingReply`) rather than any other error. */
export function isDrainingReply(reply: WireReply): boolean {
    return reply.kind === 'error' && reply.code === 'busy' && reply.message.startsWith(`${DRAINING}:`);
}
