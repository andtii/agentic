// @vitest-environment node
/** Plan mode's way out (#454): `ExitPlanMode` always reaches a person, whatever the rules and grants say. */
import { allowAll, type PolicyContext, type PolicyRequest } from '@sigx/ai-agent';
import { agentPolicy } from '../../src/policy/index';
import { EXIT_PLAN_MODE_TOOL, withPlanReview } from '../../src/claude-code/index';

const context = { sessionId: 's1', interactive: true, grants: {} as never, signal: new AbortController().signal } satisfies PolicyContext;
const ask = (toolName: string): PolicyRequest => ({ kind: 'permission', toolName, source: 'native', input: { plan: '1. read\n2. edit' } });

describe('withPlanReview (#454)', () => {
    it('asks for ExitPlanMode even under allowAll and an allow rule', async () => {
        expect(await withPlanReview(allowAll)(ask(EXIT_PLAN_MODE_TOOL), context)).toBe('ask');
        const allowing = agentPolicy({ approvalPolicy: [{ id: 'all', match: {}, outcome: 'allow' }], tools: [{ name: EXIT_PLAN_MODE_TOOL }] });
        expect(await withPlanReview(allowing)(ask(EXIT_PLAN_MODE_TOOL), context)).toBe('ask');
    });

    it('leaves every other request to the policy it wraps', async () => {
        expect(await withPlanReview(allowAll)(ask('Edit'), context)).toMatchObject({ type: 'permission', outcome: 'allow' });
        expect(await withPlanReview(undefined)(ask('Edit'), context)).toBeUndefined();
    });
});
