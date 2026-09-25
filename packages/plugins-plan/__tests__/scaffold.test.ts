/**
 * The plugins-plan scaffold (#749): the package resolves through the
 * `@agentic/plugins-plan` alias and loads as an empty module.
 */
import { describe, expect, it } from 'vitest';

describe('@agentic/plugins-plan scaffold', () => {
    it('resolves through the workspace alias and loads', async () => {
        const mod = await import('@agentic/plugins-plan');
        expect(mod).toBeTypeOf('object');
        expect(Object.keys(mod)).toEqual([]);
    });
});
