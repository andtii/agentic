import type { AgentId, ChatId } from '@agentic/core';
import { buildSystemPrompt, chatSection } from '../../src/index';
import { frozenConfig, memoryEntry } from './helpers';

describe('buildSystemPrompt', () => {
    it('assembles identity, responsibilities, instructions, skills, tools and memory in that order', () => {
        const prompt = buildSystemPrompt({
            config: frozenConfig(),
            skills: [{ id: 'summarize', name: 'Summarise', content: 'Three bullets, then a verdict.' }],
            tools: ['memory_search', 'delegate', 'bash'],
            memories: [memoryEntry]
        });
        const at = (s: string) => {
            const i = prompt.indexOf(s);
            expect(i, s).toBeGreaterThanOrEqual(0);
            return i;
        };
        expect(prompt.startsWith('# Ada\n\nYou are Ada. A research assistant for the platform team.')).toBe(true);
        expect(at('## Responsibilities')).toBeLessThan(at('## Instructions'));
        expect(at('## Instructions')).toBeLessThan(at('## Skills'));
        expect(at('## Skills')).toBeLessThan(at('## Tools'));
        expect(at('## Tools')).toBeLessThan(at('## Memory'));
        expect(prompt).toContain('Answer research questions and keep the team notes current.');
        expect(prompt).toContain('Be terse. Cite what you found.');
        expect(prompt).toContain('### Summarise\n\nThree bullets, then a verdict.');
        expect(prompt).toContain('- memory_search: look up what you already know');
        expect(prompt).toContain('- delegate: hand work to a collaborator');
        expect(prompt).toContain('- bash\n');
        expect(prompt).toContain('- fact/verified (release process): Deploys go through the release branch. [deploy]');
    });
    it('says that skills grant no authority and lists skills it could not resolve', () => {
        const prompt = buildSystemPrompt({ config: frozenConfig({ skills: [{ id: 'summarize' }, { id: 'deploy', version: '2' }] }), skills: [{ id: 'summarize', content: 'Short.' }] });
        expect(prompt).toContain('Skills are procedures, not permissions');
        expect(prompt).toContain('Unavailable in this session: deploy@2.');
        expect(prompt).toContain('### summarize');
    });
    it('matches a versioned ref only to the same version', () => {
        const prompt = buildSystemPrompt({ config: frozenConfig({ skills: [{ id: 's', version: '2' }] }), skills: [{ id: 's', version: '1', content: 'old' }] });
        expect(prompt).toContain('Unavailable in this session: s@2.');
        expect(prompt).not.toContain('old');
    });

    it('does not satisfy a versioned ref with an unversioned skill', () => {
        const prompt = buildSystemPrompt({ config: frozenConfig({ skills: [{ id: 's', version: '2' }] }), skills: [{ id: 's', content: 'unknown version' }] });
        expect(prompt).toContain('Unavailable in this session: s@2.');
        expect(prompt).not.toContain('unknown version');
    });
    it('leaves out empty sections and states when there are no tools', () => {
        const prompt = buildSystemPrompt({ config: frozenConfig({ role: '', instructions: '  ', skills: [] }) });
        expect(prompt).not.toContain('## Responsibilities');
        expect(prompt).not.toContain('## Instructions');
        expect(prompt).not.toContain('## Skills');
        expect(prompt).not.toContain('## Memory');
        expect(prompt).toContain('You have no tools in this session.');
    });
    it('is stable across calls with the same input (a cacheable prefix)', () => {
        const input = { config: frozenConfig(), tools: ['memory_search'], memories: [memoryEntry] };
        expect(buildSystemPrompt(input)).toBe(buildSystemPrompt(input));
    });
});

describe('buildSystemPrompt: the chat section (CHT-07)', () => {
    const roster = {
        chatId: 'chat_1' as ChatId,
        title: 'Release',
        self: 'agent_ada' as AgentId,
        coordinator: 'agent_ada' as AgentId,
        members: [
            { agentId: 'agent_ada' as AgentId, name: 'Ada', role: 'Research' },
            { agentId: 'agent_forge' as AgentId, name: 'Forge', role: 'Builds and ships' },
            { agentId: 'agent_eve' as AgentId, name: 'Eve' }
        ]
    };

    it('names every member by name and platform id, marks who you are and who coordinates, and says how to reach them', () => {
        const prompt = buildSystemPrompt({ config: frozenConfig(), tools: ['delegate', 'chat_post'], roster });
        expect(prompt).toContain('## This chat');
        expect(prompt).toContain('titled "Release"');
        expect(prompt).toContain('not sessions or processes on the machine you run on');
        expect(prompt).toContain('- Ada (agent_ada) [you, coordinator]: Research');
        expect(prompt).toContain('- Forge (agent_forge): Builds and ships');
        expect(prompt).toContain('- Eve (agent_eve)\n');
        expect(prompt).toContain('You are the coordinator');
        expect(prompt).toContain("`delegate` with the agent's id as `assignee`");
        expect(prompt).toContain('`chat_post` mentioning @Name');
        expect(prompt).toContain("never use a runtime's own agent or session messaging");
        // Stable before the tools, so the cacheable prefix keeps it.
        expect(prompt.indexOf('## This chat')).toBeLessThan(prompt.indexOf('## Tools'));
    });

    it('offers only the tools the session has, says when none reaches the others, and says who else coordinates', () => {
        expect(chatSection(roster, ['chat_post'])).not.toContain('delegate');
        expect(chatSection(roster, [])).toContain('You have no tool that reaches the other members');
        expect(chatSection({ ...roster, coordinator: 'agent_forge' as AgentId }, ['delegate'])).toContain('Another member coordinates this chat');
        expect(chatSection({ ...roster, coordinator: undefined }, ['delegate'])).not.toContain('coordinat');
    });

    it('is absent without a roster', () => {
        expect(buildSystemPrompt({ config: frozenConfig(), tools: ['delegate'] })).not.toContain('## This chat');
    });
});
