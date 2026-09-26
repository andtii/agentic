/** Task actor — lifecycle, waiting reasons, delegation tree, limits, stop cascade (architecture §4 Task, §7). */

export { TaskActor, DEFAULT_STOP_TIMEOUT_MS, TASK_ACTIVITY_MAX, TASK_BRANCH_MAX, type TaskMethods, type TaskStreams } from './actor.js';
export { applyTaskEntry, initialTaskState } from './entries.js';
export { IllegalTransitionError, TaskLimitError, TaskStateError, type TaskLimitKind } from './errors.js';
export { TASK_TYPE, parseTaskKey, taskKey } from './key.js';
export { TASK_INDEX_CAP, TASK_INDEX_TYPE, TaskIndex, initialTaskIndexState, newestFirst, taskIndexKey, taskIndexRowOf, trimIndex, type TaskIndexMethods, type TaskIndexQuery, type TaskIndexRow, type TaskIndexState } from './task-index.js';
export { indexTask, type TaskIndexHops } from './index-port.js';
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
export type { CancelOptions, DelegateSpec, StopReport, TaskEntry, TaskInit, TaskNote, TaskOutcome, TaskState, TaskTree, TaskView } from './types.js';
export {
    PLATFORM_MEMORY_HEADING,
    PLATFORM_MEMORY_NOTE,
    DEFAULT_RETRIEVAL_LIMIT,
    DEFAULT_RETRIEVAL_MAX_BYTES,
    CORRECTION_KINDS,
    lastUserText,
    retrievalText,
    sharedScope,
    memoryScopesOf,
    retrievalQuery,
    retrieveMemories,
    renderMemoryBlock,
    withMemoryBlock,
    turnStatusOf,
    verificationOf,
    taskOutcomeOf,
    correctionOf,
    instructionProposals,
    learningPluginFor,
    memoryAccess,
    learningAccess,
    MEMORY_OFF,
    LEARNING_OFF,
    platformLearningPorts,
    type RetrievalBudget,
    type RetrievalContext,
    type MemoryOpener,
    type RetrievedMemory,
    type SkippedScope,
    type RetrievedMemories,
    type MemoryProposal,
    type ProposalParker,
    type VerificationInput,
    type Verdict,
    type LearningPorts,
    type LearningSessionContext,
    type LearningPluginFactory,
    type TaskOutcomeInput,
    type CorrectionInput,
    type PlatformLearningPortsOptions,
    type PlatformMemory,
    type MemoryPluginImpl,
    type LearningPluginImpl,
    type SessionMemory,
    type SessionLearning
} from './driver.js';
