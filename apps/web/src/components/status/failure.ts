/**
 * Failure distinction (OPS-04, architecture §10 "Failure distinction"): the
 * one pure mapping from the live signals — this browser's socket,
 * `Machine.online`, the environment's `authStatus` and doctor verdict, the
 * session's state and last adapter error, `Task.status` / `error.code` and
 * whether the last turn ended — to exactly ONE of the named failure states
 * the design track's `FailureCard` draws (`@agentic/ui` `kit/states`):
 *
 *   client-offline  · the socket             · "This browser is offline"
 *   machine         · Machine.online         · "Machine disconnected"
 *   auth            · environment authStatus · "Sign-in needed on the machine"
 *   runtime         · adapter error event    · "Runtime error"
 *   task            · Task.status            · "Task failed"
 *   interrupted     · last event not turn-end· "Interrupted" (uncertain, OPS-05)
 *
 * Nothing here reads a hook or an actor: a page gathers what it has into
 * `FailureSignals` and renders what comes back (`FailureNotice`). Precedence
 * is the reader's: what stops THEM seeing (the socket) before what stops the
 * work (the machine, the account) before what the work reported (runtime,
 * task), and an interruption before a runtime error — its `error` event is
 * recoverable by definition.
 */
import type { AuthStatus, EnvironmentVerdict, TaskError, TaskStatus, WaitReason } from '@agentic/core';
import type { FailureKind } from '@agentic/ui';

export type ClientConnection = 'live' | 'reconnecting';

/** The session record's state as the actor reports it (`SessionInfo.status`) or the transcript folds it. */
export type SessionSignalState = 'idle' | 'running' | 'awaiting' | 'closed' | 'error' | 'disconnected';

export interface FailureSignals {
    /** This browser's socket (`components/status/client.ts`). */
    readonly client?: ClientConnection;
    /** The machine the work runs on (`Machine.get().online`); absent / null for the platform runtime. */
    readonly machine?: { readonly id: string; readonly name: string; readonly online: boolean; readonly lastSeen?: number } | null;
    /** The environment's account (`EnvironmentDescriptor.account.authStatus`) and the runtime's doctor verdict, when known. */
    readonly auth?: { readonly status: AuthStatus; readonly account?: string; readonly verdict?: EnvironmentVerdict } | null;
    /** The session: its state, the last adapter `error` event, and whether its last turn was cut short. */
    readonly session?: {
        readonly status: SessionSignalState;
        readonly error?: { readonly code: string; readonly message: string; readonly recoverable: boolean };
        /** The last turn ended as interrupted (the Session actor's marker), or did not end at all. */
        readonly interrupted?: boolean;
    } | null;
    /** The task record (`Task.get()`). */
    readonly task?: { readonly id: string; readonly status: TaskStatus; readonly error?: TaskError; readonly wait?: WaitReason } | null;
}

export interface FailureState {
    readonly kind: FailureKind;
    /** What happened, in one or two sentences, from the signal that produced the state. */
    readonly detail: string;
    /** The mono caption: the signal, refined (`Task.error.code`, the adapter code) when there is one. */
    readonly signal?: string;
    /** For `task` and `interrupted`: the task to open or resume. */
    readonly taskId?: string;
    /** For `machine` and `auth`: the machine to open. */
    readonly machineId?: string;
    /** Interrupted work is uncertain (OPS-05): what ran before the cut may or may not have taken effect. */
    readonly uncertain?: boolean;
}

/** The `requestId` the router parks an interrupted task under: `resume:{turnId}`. */
export const isResumeWait = (wait: WaitReason | undefined): boolean => wait?.kind === 'input' && wait.requestId.startsWith('resume:');

/** The Session actor's interrupted `error.code` (`INTERRUPTED_CODE`), spelled here so the browser bundle never imports the platform. */
export const INTERRUPTED_CODE = 'process_exited';

/** The adapter's own error codes (`AgentErrorCode`) — a turn that ended on one of these failed in the runtime. */
const RUNTIME_CODES: ReadonlySet<string> = new Set(['turn-error', 'rate_limited', 'context_exceeded', 'provider_error', 'protocol_error', INTERRUPTED_CODE]);

/**
 * Which named state a task's error is: the router's codes say where the
 * failure came from — an offline environment is the machine's, a login the
 * runtime could not use the account's (`auth_required`), a turn or prompt
 * that errored in the adapter the runtime's; anything else (a session that
 * could not open — `no-api-key` included, a mismatch, a cancel, the agent's
 * own report) is the task's.
 */
export function taskFailureKind(error: TaskError): FailureKind {
    const code = error.code;
    if (code === 'environment-offline' || code === 'session-refused') return 'machine';
    if (code.startsWith('auth')) return 'auth';
    if (RUNTIME_CODES.has(code) || code.startsWith('prompt-')) return 'runtime';
    return 'task';
}

const AUTH_FINDING = /auth|login|credential|token|sign/i;

/** An account that cannot authenticate: `authStatus` says so, or the doctor's verdict has an auth-shaped error. */
export function authUnavailable(auth: NonNullable<FailureSignals['auth']>): string | null {
    if (auth.status === 'missing') return `${auth.account ?? 'The account'} is not signed in on the machine.`;
    if (auth.status === 'expired') return `${auth.account ?? 'The account'}'s sign-in has expired.`;
    const finding = auth.verdict && !auth.verdict.ok ? auth.verdict.findings.find((f) => f.level === 'error' && AUTH_FINDING.test(`${f.code} ${f.message}`)) : undefined;
    return finding ? finding.message : null;
}

const age = (lastSeen: number | undefined, now: number): string => {
    if (lastSeen === undefined) return '';
    const m = Math.max(0, Math.round((now - lastSeen) / 60_000));
    return m < 1 ? ' just now' : m < 60 ? ` ${m}m ago` : ` ${Math.round(m / 60)}h ago`;
};

/**
 * The one state to show, or `null` when nothing is wrong. `now` is for the
 * machine's last-seen age; tests pass a fixed clock.
 */
export function failureOf(signals: FailureSignals, now: number = Date.now()): FailureState | null {
    const { client, machine, auth, session, task } = signals;

    // 1. The reader cannot see: everything else may be stale.
    if (client === 'reconnecting') return { kind: 'client-offline', detail: 'Your agents keep working. What you see may be out of date until the connection returns.' };

    // 2. The machine the work runs on stopped answering (Machine.online) — or the session says its daemon did.
    if (machine && !machine.online) {
        return { kind: 'machine', detail: `${machine.name} stopped answering${age(machine.lastSeen, now)}. The session is disconnected, not failed. Events replay from the daemon log when it returns.`, machineId: machine.id };
    }
    if (session?.status === 'disconnected') {
        return { kind: 'machine', signal: 'Session disconnected', detail: 'The daemon stopped answering mid-session. The session is disconnected, not failed. Events replay from the daemon log when it returns.', ...(machine ? { machineId: machine.id } : {}) };
    }

    // 3. The account cannot authenticate: work for it is held, not moved.
    if (auth) {
        const why = authUnavailable(auth);
        if (why) return { kind: 'auth', signal: `authStatus ${auth.status}`, detail: `${why} Work for it is held, not moved to another account.`, ...(machine ? { machineId: machine.id } : {}) };
    }

    // 4. A turn cut short: marked, never replayed; uncertain until a person resumes (OPS-05).
    if (session?.interrupted || (task && task.status === 'waiting' && isResumeWait(task.wait))) {
        return {
            kind: 'interrupted',
            detail: 'The platform restarted mid-turn. Nothing was replayed — what ran before the cut may or may not have taken effect. Resume sends a new prompt over the intact transcript.',
            uncertain: true,
            ...(task ? { taskId: task.id } : {})
        };
    }

    // 5. The runtime itself failed: the adapter's error event, or the session's error state.
    if (session?.error && !session.error.recoverable) {
        return { kind: 'runtime', signal: `error ${session.error.code}`, detail: `${session.error.message} The task is still open and can continue in a new turn.`, ...(task ? { taskId: task.id } : {}) };
    }
    if (session?.status === 'error') return { kind: 'runtime', detail: 'The runtime exited during the turn. The task is still open and can continue in a new turn.', ...(task ? { taskId: task.id } : {}) };

    // 6. The task reported it could not finish — by the code the router gave it.
    if (task && task.status === 'failed') {
        const error = task.error ?? { code: 'failed', message: 'The agent reported it could not finish.', recoverable: false };
        const kind = taskFailureKind(error);
        const detail = kind === 'task' ? `${error.message} Delegating agents are told.` : error.message;
        return { kind, signal: `Task.error ${error.code}`, detail, taskId: task.id, ...(machine ? { machineId: machine.id } : {}) };
    }
    return null;
}
