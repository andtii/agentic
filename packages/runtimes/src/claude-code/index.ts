/**
 * `@agentic/runtimes/claude-code` — the Claude Code driver for the machine
 * daemon (architecture §5b). Node-only: it spawns the CLI and reads profile
 * files, so it is a subpath of its own and never reaches the edge entry.
 */

export type { ClaudeCodeDriver, ClaudeCodeDriverOptions } from './driver.js';
export { claudeCodeDriver } from './driver.js';
export type { ProfileAuth, ProfileAuthDeps } from './auth.js';
export { readProfileAuth } from './auth.js';
export type { DoctorInput } from './doctor.js';
export { claudeCodeDoctor, CLAUDE_CODE_DOCTOR_CODES, configDirKey } from './doctor.js';
export type { ClaudeCodeReportInput } from './capabilities.js';
export { claudeCodeCapabilityReport } from './capabilities.js';
export type { BridgedTools } from './tools.js';
export { bridgedPlatformTools } from './tools.js';
export { claudeCodeSystemPrompt, PLATFORM_MEMORY_HEADING, PLATFORM_MEMORY_NOTE } from './system.js';
