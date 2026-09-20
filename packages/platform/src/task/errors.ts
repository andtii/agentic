/**
 * Errors the Task actor throws. Each carries a stable `code` so callers branch on it, never on the message.
 *
 * They are `ServerFnError`s: a call from another actor (or a client) crosses the wire, and only a branded error
 * keeps its `status` and message there — anything else lands as a masked 500 "Internal error". The `code` rides
 * in `data` for transports that forward it; in-process callers read it off the instance as before.
 */

import type { TaskStatus } from '@agentic/core';
import { ServerFnError } from '@sigx/server';

export type TaskLimitKind = 'depth' | 'concurrency' | 'budget';

/** A transition the state machine does not allow (architecture §7). */
export class IllegalTransitionError extends ServerFnError {
    readonly code = 'illegal-transition';
    constructor(
        readonly from: TaskStatus,
        readonly to: TaskStatus,
        readonly taskId: string
    ) {
        super(409, `task ${taskId}: illegal transition ${from} -> ${to}`, { code: 'illegal-transition', from, to });
        this.name = 'IllegalTransitionError';
    }
}

/** A delegation refused by a limit (COL-11). `limit` names the `Limits` key for `budget`. */
export class TaskLimitError extends ServerFnError {
    readonly code = 'limit';
    constructor(
        readonly kind: TaskLimitKind,
        message: string,
        readonly limit?: string
    ) {
        super(429, message, { code: 'limit', kind, ...(limit ? { limit } : {}) });
        this.name = 'TaskLimitError';
    }
}

export type TaskStateCode = 'not-created' | 'not-active' | 'wrong-state' | 'no-session' | 'bad-key';

/** The HTTP status a state error crosses the wire with: unknown task → 404, unusable key → 400, otherwise a conflict. */
const STATE_STATUS: Record<TaskStateCode, number> = { 'not-created': 404, 'bad-key': 400, 'not-active': 409, 'wrong-state': 409, 'no-session': 409 };

/** A call the task cannot honour in its current state (uncreated, no session to delegate from, ...). */
export class TaskStateError extends ServerFnError {
    constructor(
        readonly code: TaskStateCode,
        message: string
    ) {
        super(STATE_STATUS[code], message, { code });
        this.name = 'TaskStateError';
    }
}
