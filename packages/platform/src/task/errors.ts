/** Errors the Task actor throws. Each carries a stable `code` so callers branch on it, never on the message. */

import type { TaskStatus } from '@agentic/core';

export type TaskLimitKind = 'depth' | 'concurrency' | 'budget';

/** A transition the state machine does not allow (architecture §7). */
export class IllegalTransitionError extends Error {
    readonly code = 'illegal-transition';
    constructor(
        readonly from: TaskStatus,
        readonly to: TaskStatus,
        readonly taskId: string
    ) {
        super(`task ${taskId}: illegal transition ${from} -> ${to}`);
        this.name = 'IllegalTransitionError';
    }
}

/** A delegation refused by a limit (COL-11). `limit` names the `Limits` key for `budget`. */
export class TaskLimitError extends Error {
    readonly code = 'limit';
    constructor(
        readonly kind: TaskLimitKind,
        message: string,
        readonly limit?: string
    ) {
        super(message);
        this.name = 'TaskLimitError';
    }
}

/** A call the task cannot honour in its current state (uncreated, no session to delegate from, ...). */
export class TaskStateError extends Error {
    constructor(
        readonly code: 'not-created' | 'not-active' | 'no-session' | 'bad-key',
        message: string
    ) {
        super(message);
        this.name = 'TaskStateError';
    }
}
