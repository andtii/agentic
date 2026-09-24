/**
 * The failure vocabulary (`docs/design/HANDOFF.md` → "Failure
 * distinction"): six named states, each with its own name, icon, signal,
 * tone and action, so no screen ever collapses them into "Something went
 * wrong" (OPS-04). The inbox row (`NeedsItem`) and the card (`FailureCard`)
 * share this one list: `interrupted` is both an inbox kind and a failure.
 *
 * The `data-kind` axis value is the design system's declared `kind`
 * (`design-system/tokens.ts`); `client-offline` rides the declared
 * `offline` value, the other five are spelled the same on both sides.
 */
import type { IconName } from '../icons.js';
import type { Tone } from '../vocabulary.js';

export { NEEDS_KINDS } from '../vocabulary.js';
export type { NeedsKind } from '../vocabulary.js';

export const FAILURE_KINDS = ['client-offline', 'machine', 'auth', 'runtime', 'task', 'interrupted'] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

/** The `data-kind` value a failure kind renders — the design system's declared axis spelling. */
export type FailureAxis = 'offline' | 'machine' | 'auth' | 'runtime' | 'task' | 'interrupted';

export interface FailureSpec {
    /** The axis value on `data-kind`. */
    readonly axis: FailureAxis;
    /** The name shown, exactly as the handoff table. */
    readonly name: string;
    readonly icon: IconName;
    /** The mono caption naming the signal that produced the state. */
    readonly signal: string;
    readonly tone: Tone;
    /** The one action's label. */
    readonly action: string;
    /** `client-offline` has no action a person can take: the button shows "Reconnecting…" disabled. */
    readonly actionDisabled?: boolean;
    /** The default explanation, used when a caller gives no `detail`. */
    readonly detail: string;
}

export const FAILURES: Record<FailureKind, FailureSpec> = {
    'client-offline': {
        axis: 'offline',
        name: 'This browser is offline',
        icon: 'wifi',
        signal: 'client socket',
        tone: 'muted',
        action: 'Reconnecting…',
        actionDisabled: true,
        detail: 'Your agents keep working. What you see may be out of date until the connection returns.'
    },
    machine: {
        axis: 'machine',
        name: 'Machine disconnected',
        icon: 'machines',
        signal: 'Machine.online',
        tone: 'needs-you',
        action: 'Open machine',
        detail: 'The machine stopped answering. The session is disconnected, not failed. Events replay from the daemon log when it returns.'
    },
    auth: {
        axis: 'auth',
        name: 'Sign-in needed on the machine',
        icon: 'key',
        signal: 'environment authStatus',
        tone: 'needs-you',
        action: 'Re-check',
        detail: 'The account can no longer authenticate. Work for it is held, not moved to another account.'
    },
    runtime: {
        axis: 'runtime',
        name: 'Runtime error',
        icon: 'terminal',
        signal: 'adapter error event',
        tone: 'failed',
        action: 'Retry turn',
        detail: 'The runtime exited during the turn. The task is still open and can continue in a new turn.'
    },
    task: {
        axis: 'task',
        name: 'Task failed',
        icon: 'close',
        signal: 'Task.status',
        tone: 'failed',
        action: 'Open task',
        detail: 'The agent reported it could not finish. Delegating agents are told.'
    },
    interrupted: {
        axis: 'interrupted',
        name: 'Interrupted',
        icon: 'warning',
        signal: 'last event is not turn-end',
        tone: 'failed',
        action: 'Resume',
        detail: 'The platform restarted mid-turn. Nothing was replayed. Resume sends a new prompt over the intact transcript.'
    }
};

/** The `kind` axis values a failure card carries — what the empty-state scope claims and its patch wires. */
export const FAILURE_AXES: readonly FailureAxis[] = FAILURE_KINDS.map((k) => FAILURES[k].axis);

export function failureSpec(kind: FailureKind): FailureSpec {
    return FAILURES[kind];
}
