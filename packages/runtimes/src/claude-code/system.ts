/**
 * The system prompt a Claude Code session appends to the CLI's own preset,
 * with the platform's memory block labelled as not Claude Code's (MEM-10).
 */

import { withPlatformMemoryLabel } from '../harness/system.js';

export { PLATFORM_MEMORY_HEADING, CONNECTORS_UNAVAILABLE_HEADING, withUnavailableConnectors } from '../harness/system.js';

export const PLATFORM_MEMORY_NOTE =
    'Supplied by the agentic platform for this session. It is not Claude Code memory: CLAUDE.md files and Claude Code settings are not loaded here. Store what should outlive the session with memory_remember, not in files.';

/** `## Memory` (as `buildSystemPrompt` emits it) → `## Platform memory` plus the ownership note. Idempotent. */
export function claudeCodeSystemPrompt(system: string): string {
    return withPlatformMemoryLabel(system, PLATFORM_MEMORY_NOTE);
}
