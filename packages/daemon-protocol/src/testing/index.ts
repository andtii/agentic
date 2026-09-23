/** @agentic/daemon-protocol/testing — the conformance suite both ends of the daemon socket must pass, and an in-memory daemon to run it against. */

export type { ConformanceScript, ConformanceFeature, ConformanceFiles, DaemonConformanceHarness, ConformanceDaemon, PlatformSeat } from './harness.js';
export type { InMemoryFolder, InMemoryVcs } from './in-memory-files.js';
export { answerFilesOp, IN_MEMORY_SESSION_FOLDERS, IN_MEMORY_PROJECT_ROOT, IN_MEMORY_PLAIN_ROOT, IN_MEMORY_CONFORMANCE_FILES } from './in-memory-files.js';
export type { ConformanceCase, DaemonConformanceOptions } from './conformance.js';
export { daemonConformance } from './conformance.js';
export { ConformanceError } from './assert.js';
export type { InMemoryFaults, InMemoryHarnessOptions } from './in-memory.js';
export { InMemoryDaemon, inMemoryHarness, inMemoryEnvironment, IN_MEMORY_MACHINE, IN_MEMORY_ENVIRONMENT, IN_MEMORY_CAPABILITIES, IN_MEMORY_BUILD, IN_MEMORY_HARNESSES, IN_MEMORY_RELEASE, IN_MEMORY_HARNESS_TARGET } from './in-memory.js';
