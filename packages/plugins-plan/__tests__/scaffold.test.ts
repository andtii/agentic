/**
 * The plugins-plan package (#749): it resolves through the `@agentic/plugins-plan` alias and loads.
 */
import { describe, expect, it } from 'vitest';

describe('@agentic/plugins-plan package', () => {
    it('resolves through the workspace alias and loads', async () => {
        const mod = await import('@agentic/plugins-plan');
        expect(mod).toBeTypeOf('object');
        expect(mod.PLAN_FEATURE_ID).toBe('agentic.feature.plan');
    });
});
