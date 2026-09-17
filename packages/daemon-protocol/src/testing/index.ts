/** @agentic/daemon-protocol/testing — the conformance suite both ends of the daemon socket must pass, and an in-memory daemon to run it against. */

export type { ConformanceScript, ConformanceFeature, DaemonConformanceHarness, ConformanceDaemon, PlatformSeat } from './harness.js';
export type { ConformanceCase, DaemonConformanceOptions } from './conformance.js';
export { daemonConformance } from './conformance.js';
export { ConformanceError } from './assert.js';
export type { InMemoryFaults, InMemoryHarnessOptions } from './in-memory.js';
export { InMemoryDaemon, inMemoryHarness, inMemoryEnvironment, IN_MEMORY_MACHINE, IN_MEMORY_ENVIRONMENT, IN_MEMORY_CAPABILITIES } from './in-memory.js';
