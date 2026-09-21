/**
 * The system prompt a Claude Code session appends to the CLI's own preset,
 * with the platform's memory block labelled as not Claude Code's (MEM-10). The repository's own
 * CLAUDE.md is loaded by the CLI from cwd (`SETTING_SOURCES`, #461) and is not platform memory either.
 */

import { withPlatformMemoryLabel } from '../harness/system.js';

export { PLATFORM_MEMORY_HEADING, CONNECTORS_UNAVAILABLE_HEADING, withUnavailableConnectors } from '../harness/system.js';

export const PLATFORM_MEMORY_NOTE =
    'Supplied by the agentic platform for this session. It is not Claude Code memory: the CLAUDE.md and project settings of the folder are loaded as usual and belong to the project, not to this agent. Store what should outlive the session with memory_remember, not in files.';

/** `## Memory` (as `buildSystemPrompt` emits it) → `## Platform memory` plus the ownership note. Idempotent. */
export function claudeCodeSystemPrompt(system: string): string {
    return withPlatformMemoryLabel(system, PLATFORM_MEMORY_NOTE);
}
