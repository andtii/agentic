/** Task actor — lifecycle, waiting reasons, delegation tree, limits, stop cascade (architecture §4 Task, §7). */

export { TaskActor, DEFAULT_STOP_TIMEOUT_MS, type TaskMethods, type TaskStreams } from './actor.js';
export { applyTaskEntry, initialTaskState } from './entries.js';
export { IllegalTransitionError, TaskLimitError, TaskStateError, type TaskLimitKind } from './errors.js';
export { TASK_TYPE, parseTaskKey, taskKey } from './key.js';
export {
    BUDGET_KEYS,
    DEFAULT_MAX_CONCURRENT_CHILDREN,
    DEFAULT_MAX_DEPTH,
    checkConcurrency,
    checkDepth,
    remaining,
    splitBudget,
    type BudgetKey,
    type Spent
} from './limits.js';
export type { CancelOptions, DelegateSpec, StopReport, TaskEntry, TaskInit, TaskOutcome, TaskState, TaskTree, TaskView } from './types.js';
