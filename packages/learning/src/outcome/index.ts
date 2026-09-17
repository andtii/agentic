/**
 * Task outcomes (LRN-02/03). Every outcome becomes a `record`; claimed and
 * verified success stay distinct in its tags, confidence and provenance. A
 * success claim that verification refuted is also a lesson — the mistake an
 * agent should see before the next similar task.
 */

import type { NewMemoryEntry, TaskOutcome } from '@agentic/core';

/** Result text kept in a record or lesson, in characters. */
export const OUTCOME_TEXT_LIMIT = 500;

/** True only for independently verified success or failure — never for a claim. */
export function isVerified(outcome: TaskOutcome): boolean {
    return outcome.verification === 'verified' || outcome.verification === 'refuted';
}

function resultText(outcome: TaskOutcome): string {
    const text = outcome.result?.text?.trim();
    if (!text) return '';
    return `\n${text.length > OUTCOME_TEXT_LIMIT ? `${text.slice(0, OUTCOME_TEXT_LIMIT)}…` : text}`;
}

function outcomeEvidence(outcome: TaskOutcome): string[] {
    const evidence = [`task ${outcome.taskId} ${outcome.status}`, `verification: ${outcome.verification}`];
    if (outcome.result) evidence.push(`result.verified: ${outcome.result.verified}`);
    return evidence;
}

/** The record of how a task ended. The store keeps one live record per task. */
export function recordFromOutcome(outcome: TaskOutcome, at: number): NewMemoryEntry {
    const verified = isVerified(outcome);
    return {
        kind: 'record',
        text: `${outcome.status} (${outcome.verification}): ${outcome.objective}${resultText(outcome)}`,
        tags: [...outcome.tags, `outcome:${outcome.status}`, `verification:${outcome.verification}`],
        evidence: outcomeEvidence(outcome),
        confidence: verified ? 'verified' : 'assumed',
        provenance: { source: verified ? 'verification' : 'agent', at, taskId: outcome.taskId }
    };
}

/** A lesson when verification refuted what the agent claimed; otherwise none. */
export function lessonFromOutcome(outcome: TaskOutcome, at: number): NewMemoryEntry | undefined {
    if (outcome.verification !== 'refuted') return undefined;
    return {
        kind: 'lesson',
        text: `Verification refuted the claimed result of: ${outcome.objective}${resultText(outcome)}`,
        tags: [...outcome.tags, 'outcome', 'verification:refuted'],
        conditions: `Tasks like: ${outcome.objective}`,
        evidence: outcomeEvidence(outcome),
        confidence: 'verified',
        provenance: { source: 'verification', at, taskId: outcome.taskId }
    };
}
