/** Memory actor + the actor-backed MemoryPlugin; the FlatMemory actor behind the flat plugin (architecture §4 "Memory", §8). */

export type { MemoryKey, MemoryAcl, MemoryAccess } from './authorize.js';
export { parseMemoryKey, isAgentScope, scopeAgent, isMemoryOwner, memoryKeyAllows, aclAllows, memoryAuthorize } from './authorize.js';

export type { MemoryActorState, MemoryActorEntry, MemoryStats, ExportPage } from './actor.js';
export { MEMORY_ACTOR_TYPE, Memory, applyMemoryActorEntry, createMemoryActorState } from './actor.js';

export type { FlatMemoryActorState } from './flat-actor.js';
export { FLAT_MEMORY_ACTOR_TYPE, FlatMemory, createFlatMemoryActorState } from './flat-actor.js';

export type { MemoryActorClient, FlatMemoryActorClient, MemoryStoreClient, MemoryActorPluginOptions, FlatMemoryActorPluginOptions } from './plugin.js';
export { MEMORY_WIRE_BATCH, MAX_RETRIEVAL_LIMIT, RETRIEVAL_LIMIT_KEY, memoryActorKey, actorMemoryStore, memoryActorPlugin, memoryActorImpl, flatMemoryActorPlugin, flatMemoryActorImpl, isolateMemoryImpl, retrievalFromConfig } from './plugin.js';

export type { MemoryScopeMigration, MemorySwitchReport, MemorySwitchInput } from './switch.js';
export { MemorySwitchError, workspaceMemoryScopes, switchMemory } from './switch.js';
