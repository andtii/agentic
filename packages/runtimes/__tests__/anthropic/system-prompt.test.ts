import { buildSystemPrompt } from '../../src/index';
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
