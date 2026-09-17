/**
 * The system prompt of a platform-managed agent, assembled from its frozen
 * config: identity and role, instructions, skills, the tools it has, and
 * the memory block retrieved for this session.
 *
 * Section order is stable-first: everything that is the same across a
 * session's turns comes before the memory block, which changes per
 * retrieval, so a provider's prompt cache keeps the long prefix.
 */

import type { AgentConfig, MemoryEntry, SkillRef } from '@agentic/core';

/** A skill's text, resolved by the platform from a `SkillRef` (AGT-04: text, never authority). */
export interface ResolvedSkill {
    readonly id: string;
    readonly version?: string;
    readonly name?: string;
    readonly content: string;
}

export interface SystemPromptInput {
    readonly config: AgentConfig;
    /** Skills the platform resolved; a `SkillRef` with no match is listed as unavailable. */
    readonly skills?: readonly ResolvedSkill[];
    /** The tools on this session's roster, by name. */
    readonly tools?: readonly string[];
    /** Memories retrieved for this session (MEM-04). */
    readonly memories?: readonly MemoryEntry[];
}

const TOOL_GUIDE: Readonly<Record<string, string>> = {
    memory_search: 'look up what you already know before asking or guessing',
    memory_remember: 'keep facts, preferences and lessons that outlive this session',
    delegate: 'hand work to a collaborator and wait for its result',
    chat_post: 'speak in the chat; mention an agent to address it',
    task_report: 'report progress, a blocker, or the final result of your task',
    ask_user: 'ask the user only for a decision that is theirs to make'
};

function skillKey(ref: SkillRef): string {
    return ref.version !== undefined ? `${ref.id}@${ref.version}` : ref.id;
}

function resolveSkills(refs: readonly SkillRef[], resolved: readonly ResolvedSkill[] = []): { found: ResolvedSkill[]; missing: string[] } {
    const found: ResolvedSkill[] = [];
    const missing: string[] = [];
    for (const ref of refs) {
        // A pinned ref needs the same version; an unversioned skill cannot vouch for it.
        const skill = resolved.find((s) => s.id === ref.id && (ref.version === undefined || s.version === ref.version));
        if (skill) found.push(skill);
        else missing.push(skillKey(ref));
    }
    return { found, missing };
}

function memoryLine(m: MemoryEntry): string {
    const tags = m.tags.length ? ` [${m.tags.join(', ')}]` : '';
    const subject = m.subject !== undefined ? ` (${m.subject})` : '';
    return `- ${m.kind}/${m.confidence}${subject}: ${m.text}${tags}`;
}

export function buildSystemPrompt(input: SystemPromptInput): string {
    const { config } = input;
    const sections: string[] = [];

    const identity = [`You are ${config.name}.`, config.description.trim()].filter(Boolean).join(' ');
    sections.push(`# ${config.name}\n\n${identity}`);

    if (config.role.trim()) sections.push(`## Responsibilities\n\n${config.role.trim()}`);
    if (config.instructions.trim()) sections.push(`## Instructions\n\n${config.instructions.trim()}`);

    if (config.skills.length) {
        const { found, missing } = resolveSkills(config.skills, input.skills);
        const parts = found.map((s) => `### ${s.name ?? s.id}\n\n${s.content.trim()}`);
        if (missing.length) parts.push(`Unavailable in this session: ${missing.join(', ')}.`);
        sections.push(`## Skills\n\nSkills are procedures, not permissions: they grant no tools or credentials beyond those listed below.\n\n${parts.join('\n\n')}`);
    }

    const tools = input.tools ?? [];
    if (tools.length) {
        const lines = tools.map((name) => (TOOL_GUIDE[name] ? `- ${name}: ${TOOL_GUIDE[name]}` : `- ${name}`));
        sections.push(`## Tools\n\nYou may call only these tools; some calls need approval, which is asked for automatically.\n\n${lines.join('\n')}`);
    } else {
        sections.push('## Tools\n\nYou have no tools in this session.');
    }

    if (input.memories?.length) {
        sections.push(`## Memory\n\nRetrieved for this session; assumptions are marked as such.\n\n${input.memories.map(memoryLine).join('\n')}`);
    }

    return sections.join('\n\n');
}
