/** Agent actor — identity, versioned config, `snapshotForSession` (architecture §4). */
export { AgentActor, agentKey, agentMemoryScope, principalLabel, type AgentView } from './agent.actor.js';
export {
    type AgentConfigEntry,
    type AgentEntry,
    type AgentProposalEntry,
    type AgentState,
    type AgentVersionInfo,
    type InstructionProposal,
    type PendingProposal,
    type ProposalOrigin,
    type ProposalStatus,
    appendInstruction,
    applyAgentEntry,
    configAtVersion,
    initialAgentState,
    parseAgentKey
} from './entries.js';
export { type AgentConfigPatch, defaultAgentConfig, mergeAgentConfig } from './config.js';
