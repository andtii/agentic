/** Prompt parts ↔ A2A parts, each way. */
import type { PromptPart } from '@sigx/ai-agent';
import { toA2aParts, toPromptParts } from '../src/index';

describe('part mapping', () => {
    it('round-trips every prompt part kind, resources included', () => {
        const parts: PromptPart[] = [
            { type: 'text', text: 'hello' },
            { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' },
            { type: 'file', mediaType: 'application/pdf', url: 'https://x.test/a.pdf', filename: 'a.pdf' },
            { type: 'resource', uri: 'file:///notes.md', name: 'notes', mediaType: 'text/markdown', text: '# Notes' },
            { type: 'resource', uri: 'https://x.test/spec' }
        ];
        expect(toPromptParts(toA2aParts(parts))).toEqual(parts);
    });
    it('keeps a data part out of the prompt', () => {
        expect(toPromptParts([{ data: { a: 1 } }, { text: 'hi' }])).toEqual([{ type: 'text', text: 'hi' }]);
    });
});
