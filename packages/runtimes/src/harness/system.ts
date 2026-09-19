/**
 * The system prompt a harness session runs with. The platform assembles it
 * (`buildSystemPrompt`); here the memory block is relabelled as platform-owned,
 * so neither the model nor a reader of the prompt mistakes it for the
 * harness's own memory (MEM-10), and connectors this machine could not open
 * are named (#280).
 */

export const PLATFORM_MEMORY_HEADING = '## Platform memory';

/** `## Memory` (as `buildSystemPrompt` emits it) → `## Platform memory` plus `note`, which says what the harness does not load. Idempotent. */
export function withPlatformMemoryLabel(system: string, note: string): string {
    if (system.includes(PLATFORM_MEMORY_HEADING)) return system;
    return system.replace(/^## Memory$/m, `${PLATFORM_MEMORY_HEADING}\n\n${note}`);
}

/** The heading `buildSystemPrompt` gives connectors the platform could not place on the session (#240). */
export const CONNECTORS_UNAVAILABLE_HEADING = '## Connectors not available';

const CONNECTORS_UNAVAILABLE_INTRO =
    'These connectors are configured for you but their tools are not in this session; if the user needs one, say which and why.';

/**
 * `system` with the connectors this machine could not open named, and why (#280): added to the platform's own
 * "Connectors not available" section when it has one, else as that section at the end.
 */
export function withUnavailableConnectors(system: string, unavailable: readonly { readonly id: string; readonly reason: string }[]): string {
    if (unavailable.length === 0) return system;
    const lines = unavailable.map((c) => `- ${c.id}: ${c.reason}`).join('\n');
    const at = system.indexOf(`${CONNECTORS_UNAVAILABLE_HEADING}\n`);
    if (at < 0) return `${system.replace(/\s+$/, '')}\n\n${CONNECTORS_UNAVAILABLE_HEADING}\n\n${CONNECTORS_UNAVAILABLE_INTRO}\n\n${lines}`;
    const next = system.indexOf('\n## ', at + CONNECTORS_UNAVAILABLE_HEADING.length);
    const end = next < 0 ? system.length : next;
    const section = system.slice(0, end).replace(/\s+$/, '');
    const rest = system.slice(end);
    return rest ? `${section}\n${lines}\n${rest}` : `${section}\n${lines}`;
}
