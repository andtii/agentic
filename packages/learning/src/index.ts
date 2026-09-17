/**
 * @agentic/learning — the default LearningPlugin (LRN-01..06, LRN-08/09):
 * corrections become lessons with evidence and conditions, task outcomes
 * become records with claimed and verified success kept apart, repeated
 * corrections become review-gated instruction proposals. Works over any
 * `MemoryStore`; never proposes a permission.
 */
export const PACKAGE = '@agentic/learning';

export type { PermissionKey, DeepKeys, PermissionFree, InstructionProposal, MemoryProposal, AppliedProposals } from './proposals/index.js';
export { PERMISSION_KEYS, LearningPermissionError, assertPermissionFree, applyProposals } from './proposals/index.js';

export type { CorrectionTally, CorrectionLedger, MemoryCorrectionLedger } from './ledger/index.js';
export { isoWeek, memoryCorrectionLedger } from './ledger/index.js';

export type { LearningContext, RelevantLessonsOptions } from './lessons/index.js';
export {
    CORRECTION_TAG,
    EVIDENCE_CORRECTION_PREFIX,
    words,
    similarity,
    correctionEvidence,
    correctionOccurrences,
    lessonFromCorrection,
    findSimilarLesson,
    mergeLesson,
    relevantLessons,
    retireLesson,
    supersedeLesson
} from './lessons/index.js';

export { OUTCOME_TEXT_LIMIT, isVerified, recordFromOutcome, lessonFromOutcome } from './outcome/index.js';

export type { LearningPluginOptions } from './plugin/index.js';
export { learningPlugin, DEFAULT_LEARNING_PLUGIN_ID, DEFAULT_LEARNING_PLUGIN_VERSION } from './plugin/index.js';
