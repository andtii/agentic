/**
 * The system prompt of a platform-managed agent, assembled from its frozen
 * config: identity and role, instructions, skills, the tools it has, and
 * the memory block retrieved for this session.
 *
 * Section order is stable-first: everything that is the same across a
 * session's turns comes before the memory block, which changes per
 * retrieval, so a provider's prompt cache keeps the long prefix.
 */

import type { AgentConfig, ChatRoster, MemoryEntry, SkillRef } from '@agentic/core';

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
    /** The chat the session works in, when it came from one (CHT-07): who else is there and who coordinates. */
    readonly roster?: ChatRoster;
    /**
     * Connectors the agent is configured with that this session could not use, and why (#240) — so the agent
     * says what it cannot do instead of guessing at tools that are not there.
     */
    readonly unavailableConnectors?: readonly { readonly id: string; readonly reason: string }[];
    /**
     * The project's instructions (#332): what the enabled project feature plugins say about the project the task
     * belongs to (`instructions()` merged with what `beforeSession` returned), rendered as a `## Project` section.
     */
    readonly project?: string;
}

const TOOL_GUIDE: Readonly<Record<string, string>> = {
    memory_search: 'look up what you already know before asking or guessing',
    memory_remember: 'keep facts, preferences and lessons that outlive this session',
    delegate: 'hand work to a collaborator and wait for its result',
    chat_post: 'speak in the chat; an agent id in `mentions` starts that agent, which answers in the chat; attach chat files by their agentic-file: URI',
    chat_file_read: 'read a file attached to the chat by its agentic-file: URI',
    task_report: 'report progress, a blocker, or the final result of your task',
    ask_user: 'ask the user only for a decision that is theirs to make; on `pending`, end your turn — the answer starts you again'
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

/**
 * The chat section: every member by name and id, the coordinator, and how
 * to reach the others — only through the platform's own tools. Without it
 * a runtime with agent tools of its own (Claude Code's cross-session
 * messaging) takes "the other agents" to mean whatever it can see locally.
 */
export function chatSection(roster: ChatRoster, tools: readonly string[]): string {
    const lines = roster.members.map((m) => {
        const tags = [m.agentId === roster.self ? 'you' : '', m.agentId === roster.coordinator ? 'coordinator' : ''].filter(Boolean);
        const role = m.role?.trim();
        return `- ${m.name} (${m.agentId})${tags.length ? ` [${tags.join(', ')}]` : ''}${role ? `: ${role}` : ''}`;
    });
    const title = roster.title ? ` titled "${roster.title}"` : '';
    const paragraphs = [
        `You work in a chat${title} with the user and these agents. They are agents of this platform, not sessions or processes on the machine you run on.`,
        lines.join('\n')
    ];
    if (roster.coordinator === roster.self) paragraphs.push('You are the coordinator: when the user mentions nobody, you answer, and you bring in the other members as the work needs them.');
    else if (roster.coordinator) paragraphs.push('Another member coordinates this chat; answer what is addressed to you.');
    if (roster.members.some((m) => m.agentId !== roster.self)) {
        const ways = [
            tools.includes('delegate') ? "`delegate` with the agent's id as `assignee`, for work you need back as a result" : '',
            tools.includes('chat_post') ? "`chat_post` with the agent's id in `mentions`, to start it on your message — it answers in the chat, not to you" : ''
        ].filter(Boolean);
        paragraphs.push(
            ways.length
                ? `To involve another member use ${ways.join(', or ')}. Nothing else reaches them: never use a runtime's own agent or session messaging for chat members.`
                : 'You have no tool that reaches the other members in this session; say so if you are asked to involve them.'
        );
    }
    return `## This chat\n\n${paragraphs.join('\n\n')}`;
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
    if (input.roster) sections.push(chatSection(input.roster, tools));
    if (input.project?.trim()) sections.push(`## Project\n\n${input.project.trim()}`);

    if (tools.length) {
        const lines = tools.map((name) => (TOOL_GUIDE[name] ? `- ${name}: ${TOOL_GUIDE[name]}` : `- ${name}`));
        sections.push(`## Tools\n\nYou may call only these tools; some calls need approval, which is asked for automatically.\n\n${lines.join('\n')}`);
    } else {
        sections.push('## Tools\n\nYou have no tools in this session.');
    }
    if (input.unavailableConnectors?.length) {
        const lines = input.unavailableConnectors.map((c) => `- ${c.id}: ${c.reason}`);
        sections.push(`## Connectors not available\n\nThese connectors are configured for you but their tools are not in this session; if the user needs one, say which and why.\n\n${lines.join('\n')}`);
    }

    if (input.memories?.length) {
        sections.push(`## Memory\n\nRetrieved for this session; assumptions are marked as such.\n\n${input.memories.map(memoryLine).join('\n')}`);
    }

    return sections.join('\n\n');
}
