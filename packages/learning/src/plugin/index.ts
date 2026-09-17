/**
 * `learningPlugin` — the default LearningPlugin (LRN-01). Corrections become
 * lessons, outcomes become records (and refuted claims lessons); a correction
 * the user keeps repeating yields an instruction proposal that waits for
 * review. Memory proposals are applied automatically unless `apply: false`;
 * nothing the plugin returns can carry a permission (LRN-08).
 */

import type { Correction, LearningPlugin, MemoryStore, Proposal, TaskOutcome } from '@agentic/core';
import { isoWeek, memoryCorrectionLedger, type CorrectionLedger } from '../ledger/index.js';
import { correctionOccurrences, findSimilarLesson, lessonFromCorrection, mergeLesson, type LearningContext } from '../lessons/index.js';
import { lessonFromOutcome, recordFromOutcome } from '../outcome/index.js';
import { applyProposals, assertPermissionFree, type InstructionProposal } from '../proposals/index.js';

export const DEFAULT_LEARNING_PLUGIN_ID = 'agentic.learning.default';
export const DEFAULT_LEARNING_PLUGIN_VERSION = '0.1.0';

export interface LearningPluginOptions {
    readonly id?: string;
    readonly version?: string;
    /** The clock for outcomes (corrections carry their own `at`). Default `Date.now`. */
    readonly now?: () => number;
    /** LRN-09 counters. Default: an in-memory ledger. */
    readonly ledger?: CorrectionLedger;
    /** The task or request a correction belongs to; becomes the lesson's conditions and tags. */
    readonly contextFor?: (correction: Correction) => LearningContext | undefined | Promise<LearningContext | undefined>;
    /** Learn from agent-detected corrections too. Default `false` (architecture §8: off by default). */
    readonly acceptAgentCorrections?: boolean;
    /** Write memory proposals to the store before returning them. Default `true`. */
    readonly apply?: boolean;
    /** Word overlap (Jaccard) at which a correction repeats an existing lesson. Default 0.6. */
    readonly similarity?: number;
    /** Repetitions of one user correction that trigger an instruction proposal (and every multiple after). Default 3. */
    readonly repeatThreshold?: number;
    /** Evidence lines kept on a lesson (the repetition count is kept apart and never capped). Default 50. */
    readonly evidenceCap?: number;
}

const INSTRUCTION_VERB: Record<Correction['what'], string> = {
    never: 'Never',
    prefer: 'Prefer',
    wrong: 'Avoid this repeated mistake'
};

function instructionFor(c: Correction, occurrences: number, weekTotal: number, week: string): InstructionProposal {
    return {
        kind: 'instruction',
        patch: `${INSTRUCTION_VERB[c.what]}: ${c.text}`,
        reason: `The user made this correction ${occurrences} times (${weekTotal} corrections for this agent in ${week}).`,
        requiresReview: true
    };
}

export function learningPlugin(options: LearningPluginOptions = {}): LearningPlugin {
    const now = options.now ?? Date.now;
    const ledger = options.ledger ?? memoryCorrectionLedger();
    const threshold = Math.max(1, options.repeatThreshold ?? 3);
    const minSimilarity = options.similarity ?? 0.6;
    const evidenceCap = Math.max(1, options.evidenceCap ?? 50);
    const apply = options.apply ?? true;

    const finish = async (proposals: Proposal[], memory: MemoryStore): Promise<readonly Proposal[]> => {
        assertPermissionFree(proposals);
        if (apply) await applyProposals(proposals, memory);
        return proposals;
    };

    return {
        id: options.id ?? DEFAULT_LEARNING_PLUGIN_ID,
        version: options.version ?? DEFAULT_LEARNING_PLUGIN_VERSION,

        async onCorrection(correction, memory) {
            if (correction.by === 'agent' && !options.acceptAgentCorrections) return [];
            const week = isoWeek(correction.at);
            const weekTotal = await ledger.recordCorrection({ agentId: correction.agentId, week, what: correction.what, at: correction.at });
            const lesson = lessonFromCorrection(correction, await options.contextFor?.(correction));
            const previous = await findSimilarLesson(memory, correction, minSimilarity);
            const entry = previous ? mergeLesson(previous, lesson, evidenceCap) : lesson;
            const proposals: Proposal[] = [{ kind: 'memory', entry }];
            const occurrences = correctionOccurrences(entry);
            if (correction.by === 'user' && occurrences % threshold === 0) proposals.push(instructionFor(correction, occurrences, weekTotal, week));
            return finish(proposals, memory);
        },

        async onTaskEnd(outcome: TaskOutcome, memory) {
            const at = now();
            const proposals: Proposal[] = [{ kind: 'memory', entry: recordFromOutcome(outcome, at) }];
            const lesson = lessonFromOutcome(outcome, at);
            if (lesson) proposals.push({ kind: 'memory', entry: lesson });
            return finish(proposals, memory);
        }
    };
}
