/**
 * Plan mode's way out (#454). In `plan` Claude Code does nothing but plan, then calls `ExitPlanMode` with the plan
 * and waits for the answer. That call must reach a person: allowed silently (a grant, an allow rule, `allowAll`), the
 * CLI would leave plan mode with nobody having read the plan. So it always asks, ahead of every rule and grant; the
 * web shows the plan and approves it into a mode, or denies it to keep planning.
 */

import type { Policy } from '@sigx/ai-agent';

/** Claude Code's tool that ends plan mode; its input carries the plan (`plan`, markdown). */
export const EXIT_PLAN_MODE_TOOL = 'ExitPlanMode';

/** `policy` with `ExitPlanMode` always asked — never allowed or denied by a rule, a grant or the fallback. */
export function withPlanReview(policy: Policy | undefined): Policy {
    const reviewed: Policy = (request, context) => {
        if (request.kind === 'permission' && request.toolName === EXIT_PLAN_MODE_TOOL) return 'ask';
        return policy ? policy(request, context) : undefined;
    };
    return Object.assign(reviewed, { id: policy?.id ?? 'plan-review' });
}
