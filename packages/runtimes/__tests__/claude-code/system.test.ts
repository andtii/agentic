/** `claudeCodeSystemPrompt`: platform memory labelled as platform-owned (MEM-10). */
import { claudeCodeSystemPrompt, PLATFORM_MEMORY_HEADING, PLATFORM_MEMORY_NOTE } from '../../src/claude-code/index';

describe('claudeCodeSystemPrompt', () => {
    const system = '# Ada\n\nBe brief.\n\n## Memory\n\nRetrieved for this session.\n\n- fact: x';

    it('relabels the memory block and states who owns it', () => {
        const out = claudeCodeSystemPrompt(system);
        expect(out).toContain(`${PLATFORM_MEMORY_HEADING}\n\n${PLATFORM_MEMORY_NOTE}\n\nRetrieved for this session.`);
        expect(out).not.toMatch(/^## Memory$/m);
        expect(out.startsWith('# Ada\n\nBe brief.')).toBe(true);
    });

    it('is idempotent and leaves a prompt without a memory block unchanged', () => {
        expect(claudeCodeSystemPrompt(claudeCodeSystemPrompt(system))).toBe(claudeCodeSystemPrompt(system));
        expect(claudeCodeSystemPrompt('# Ada\n\n## Memoryless notes')).toBe('# Ada\n\n## Memoryless notes');
    });
});
