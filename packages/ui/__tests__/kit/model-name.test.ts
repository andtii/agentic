import { modelDisplayName } from '@agentic/ui';

describe('modelDisplayName (#517)', () => {
    it('names a full id by family and version', () => {
        expect(modelDisplayName('claude-fable-5-1')).toBe('Fable 5.1');
        expect(modelDisplayName('claude-opus-5-5')).toBe('Opus 5.5');
        expect(modelDisplayName('claude-opus-5')).toBe('Opus 5');
        expect(modelDisplayName('claude-sonnet-5')).toBe('Sonnet 5');
        expect(modelDisplayName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
        expect(modelDisplayName('claude-mythos-5-1')).toBe('Mythos 5.1');
        expect(modelDisplayName('claude-sonnet-4.5')).toBe('Sonnet 4.5');
    });

    it('says when a model runs with the 1M context', () => {
        expect(modelDisplayName('claude-fable-5-1[1m]')).toBe('Fable 5.1 (1M context)');
    });

    it("takes an alias's version from what the account says about it", () => {
        expect(modelDisplayName('opus[1m]', { label: 'Opus (1M context)', description: 'Opus 5.5 with 1M context · Most capable for complex work' })).toBe('Opus 5.5 (1M context)');
        expect(modelDisplayName('sonnet', { label: 'Sonnet', description: 'Sonnet 5 · Best for everyday tasks' })).toBe('Sonnet 5');
        expect(modelDisplayName('haiku')).toBe('Haiku');
        // Another family named first is not this alias's version.
        expect(modelDisplayName('haiku', { description: 'Faster than Opus 5.5 · Haiku 4.5' })).toBe('Haiku 4.5');
    });

    it('names the default by the model it currently runs', () => {
        expect(modelDisplayName('default', { label: 'Default (recommended)', description: 'Use the default model (currently Opus 5.5 (1M context))' })).toBe('Default (Opus 5.5)');
        expect(modelDisplayName('default', { label: 'Default (recommended)' })).toBe('Default');
    });

    it("leaves a model it does not know to its label, else its id", () => {
        expect(modelDisplayName('gpt-9', { label: 'GPT 9' })).toBe('GPT 9');
        expect(modelDisplayName('claude-3-5-sonnet-20241022')).toBe('claude-3-5-sonnet-20241022');
    });
});
