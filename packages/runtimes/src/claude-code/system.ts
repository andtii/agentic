/**
 * The system prompt a Claude Code session appends to the CLI's own preset.
 * The platform assembles it (`buildSystemPrompt`); here the memory block is
 * relabelled as platform-owned, so neither the model nor a reader of the
 * prompt mistakes it for Claude Code's own memory (MEM-10).
 */

export const PLATFORM_MEMORY_HEADING = '## Platform memory';

export const PLATFORM_MEMORY_NOTE =
    'Supplied by the agentic platform for this session. It is not Claude Code memory: CLAUDE.md files and Claude Code settings are not loaded here. Store what should outlive the session with memory_remember, not in files.';

/** `## Memory` (as `buildSystemPrompt` emits it) → `## Platform memory` plus the ownership note. Idempotent. */
export function claudeCodeSystemPrompt(system: string): string {
    if (system.includes(PLATFORM_MEMORY_HEADING)) return system;
    return system.replace(/^## Memory$/m, `${PLATFORM_MEMORY_HEADING}\n\n${PLATFORM_MEMORY_NOTE}`);
}
