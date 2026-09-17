/**
 * A tool part's lifecycle, in the two vocabularies a card needs: the product
 * PHASE (`pending | running | done | error | denied`, what the status text
 * says) and the governed zero STATE the anatomy declares for `data-state`
 * (`loading | active | complete | error | closed`) — see `./anatomy`.
 */
import type { AgentStatus } from '@sigx/ai-agent';
import type { ToolPartState } from '@sigx/ai-agent/app';
import type { LIFECYCLE_STATES } from './anatomy.js';

export type LifecycleState = (typeof LIFECYCLE_STATES)[number];
export type ToolCallPhase = 'pending' | 'running' | 'done' | 'error' | 'denied';

export interface ToolCallView {
    readonly phase: ToolCallPhase;
    readonly state: LifecycleState;
    /** The status text — the phase, refined: `writing arguments`, `awaiting approval`, `cancelled`, `done, no output`. */
    readonly label: string;
}

const STATE_OF: Record<ToolCallPhase, LifecycleState> = {
    pending: 'loading',
    running: 'active',
    done: 'complete',
    error: 'error',
    denied: 'closed'
};

function phaseOf(p: ToolPartState): ToolCallPhase {
    switch (p.status) {
        case 'streaming':
        case 'pending':
            return 'pending';
        case 'in_progress':
            return 'running';
        case 'completed':
            return 'done';
        case 'denied':
            return 'denied';
        default:
            return 'error';
    }
}

/** What the card reads off a part — `awaiting` is a pending call whose permission request is still open. */
export function toolCallState(p: ToolPartState, opts: { readonly awaiting?: boolean; readonly emptyOutput?: boolean } = {}): ToolCallView {
    const phase = phaseOf(p);
    let label: string = phase;
    if (p.status === 'streaming') label = 'writing arguments';
    else if (phase === 'pending' && opts.awaiting) label = 'awaiting approval';
    else if (p.status === 'cancelled') label = 'cancelled';
    else if (phase === 'done' && opts.emptyOutput) label = 'done, no output';
    return { phase, state: STATE_OF[phase], label };
}

/** A sub-agent's status on the same governed set: paused is a wait, cancelled a dismissal. */
export function agentState(status: AgentStatus): LifecycleState {
    switch (status) {
        case 'running':
            return 'active';
        case 'paused':
            return 'loading';
        case 'completed':
            return 'complete';
        case 'failed':
            return 'error';
        default:
            return 'closed';
    }
}
