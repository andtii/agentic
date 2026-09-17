/** @agentic/memory/testing — the conformance suite every MemoryStore backend runs (MEM-02). */

export type { MemoryConformanceCase, MemoryConformanceOptions, MemoryStoreFactory } from './conformance.js';
export { memoryConformance } from './conformance.js';
export { MemoryConformanceError, assert, assertEqual, assertRejects, jsonEqual } from './assert.js';
