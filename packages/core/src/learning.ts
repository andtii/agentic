/** Learning seams (LRN-01..09). Implementations live in @agentic/learning. */

import type { AgentId, MessageId, SessionId, TaskId } from './ids.js';
import type { MemoryStore, NewMemoryEntry } from './memory.js';
import type { TaskResult } from './task.js';

export interface TaskOutcome {
    readonly taskId: TaskId;
    readonly agentId: AgentId;
    readonly status: 'completed' | 'failed' | 'cancelled';
    readonly result?: TaskResult;
    /** Claimed by the agent vs independently verified (LRN-03). */
    readonly verification: 'none' | 'claimed' | 'verified' | 'refuted';
    readonly objective: string;
    readonly tags: readonly string[];
}

export interface Correction {
    readonly agentId: AgentId;
    readonly sessionId: SessionId;
    readonly messageId: MessageId;
    readonly text: string;
    readonly what: 'wrong' | 'prefer' | 'never';
    readonly by: 'user' | 'agent';
    readonly at: number;
}

/** What learning may propose. Instruction patches always require review (LRN-08). */
export type Proposal =
    | { readonly kind: 'memory'; readonly entry: NewMemoryEntry }
    | { readonly kind: 'instruction'; readonly patch: string; readonly reason: string; readonly requiresReview: true };

export interface LearningPlugin {
    readonly id: string;
    readonly version: string;
    onTaskEnd(outcome: TaskOutcome, memory: MemoryStore): Promise<readonly Proposal[]>;
    onCorrection(correction: Correction, memory: MemoryStore): Promise<readonly Proposal[]>;
}
