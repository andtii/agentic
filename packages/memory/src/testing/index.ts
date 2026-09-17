/** @agentic/memory/testing — the conformance suite every MemoryStore backend runs (MEM-02). */

export type { MemoryConformanceCase, MemoryConformanceOptions, MemoryStoreFactory, MemoryFeature } from './conformance.js';
export { memoryConformance, MEMORY_FEATURES } from './conformance.js';
export { MemoryConformanceError, assert, assertEqual, assertRejects, jsonEqual } from './assert.js';
