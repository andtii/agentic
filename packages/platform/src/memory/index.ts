/** Memory actor + the actor-backed MemoryPlugin (architecture §4 "Memory", §8). */

export type { MemoryKey, MemoryAcl, MemoryAccess } from './authorize.js';
export { parseMemoryKey, isAgentScope, scopeAgent, isMemoryOwner, memoryKeyAllows, aclAllows, memoryAuthorize } from './authorize.js';

export type { MemoryActorState, MemoryActorEntry, MemoryStats, ExportPage } from './actor.js';
export { MEMORY_ACTOR_TYPE, Memory, applyMemoryActorEntry, createMemoryActorState } from './actor.js';

export type { MemoryActorClient, MemoryActorPluginOptions } from './plugin.js';
export { MEMORY_WIRE_BATCH, RETRIEVAL_LIMIT_KEY, memoryActorKey, actorMemoryStore, memoryActorPlugin, memoryActorImpl, isolateMemoryImpl, retrievalFromConfig } from './plugin.js';
