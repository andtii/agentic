/**
 * The agent's approval rules as a `@sigx/ai-agent` `Policy` (AGT-04, COL-10,
 * AC-12). `ApprovalRule`s are first-match over `{tools, categories, source}`;
 * `ToolGrant`s decide per tool (`ask` → the approval flow, `deny` → refused,
 * default allow). Across delegation a child runs under its own policy
 * CONSTRAINED by the chain of its ancestors' rules: the child's rule decides
 * first, and an ancestor's `deny` / `ask` can only tighten it — never widen.
 *
 * Lives in `@agentic/runtimes` so the machine daemon compiles the same policy
 * from the rules an `OpenSpec` carries (#121); `@agentic/platform` re-exports it.
 */

import type { ApprovalRule, FrozenAgentConfig, OpenSpecPolicy, ToolGrant } from '@agentic/core';
import { allowAll, firstMatch, type Policy, type PolicyRequest, type PolicyResult } from '@sigx/ai-agent';

/** Does `rule.match` cover `request`? An empty match covers every permission request. */
export function ruleMatches(rule: ApprovalRule, request: PolicyRequest): boolean {
    const m = rule.match;
    if (m.tools && (request.toolName === undefined || !m.tools.includes(request.toolName))) return false;
    if (m.categories && (request.category === undefined || !(m.categories as readonly string[]).includes(request.category))) return false;
    if (m.source !== undefined && m.source !== request.source) return false;
    return true;
}

function decide(outcome: ApprovalRule['outcome'], id: string, scope: ApprovalRule['scope'], message?: string): PolicyResult {
    if (outcome === 'ask') return 'ask';
    return { type: 'permission', outcome, scope: scope ?? 'once', ruleId: id, ...(outcome === 'deny' ? { message: message ?? `denied by approval rule "${id}"` } : {}) };
}

/**
 * The agent's `approvalPolicy` rules, first match decides; no matching rule →
 * no opinion (composes in `firstMatch`). Only permission requests are decided:
 * an input request always goes to the client.
 */
export function compilePolicy(rules: readonly ApprovalRule[]): Policy {
    const policy: Policy = (request) => {
        if (request.kind !== 'permission') return undefined;
        for (const rule of rules) if (ruleMatches(rule, request)) return decide(rule.outcome, rule.id, rule.scope);
        return undefined;
    };
    return Object.assign(policy, { id: 'approval-policy' });
}

/** The tool grants as a policy: `ask` asks, `deny` denies, an `allow` grant allows; a tool without a grant gets no opinion. */
export function grantPolicy(grants: readonly ToolGrant[]): Policy {
    const byName = new Map(grants.map((g) => [g.name, g.mode ?? 'allow'] as const));
    const policy: Policy = (request) => {
        if (request.kind !== 'permission' || request.toolName === undefined) return undefined;
        const mode = byName.get(request.toolName);
        if (mode === undefined) return undefined;
        return decide(mode, `grant:${request.toolName}`, 'once', `tool "${request.toolName}" is denied by its grant`);
    };
    return Object.assign(policy, { id: 'tool-grants' });
}

/** deny > ask > allow > no opinion. */
function rank(result: PolicyResult): number {
    if (result === undefined) return 0;
    if (result === 'ask') return 2;
    if (result.type === 'permission') return result.outcome === 'deny' ? 3 : 1;
    return 3; // a cancel decision is as final as a deny
}

/**
 * `policy` under `constraints`: both are consulted and the stricter answer
 * wins (deny > ask > allow), so a delegated session is never wider than the
 * chain above it (COL-10, AC-12). Where one side has no opinion, the other
 * decides.
 */
export function constrainPolicy(policy: Policy, constraints: Policy): Policy {
    const combined: Policy = async (request, context) => {
        const own = await policy(request, context);
        const bound = await constraints(request, context);
        return rank(bound) > rank(own) ? bound : own;
    };
    return Object.assign(combined, { id: policy.id ?? 'constrained' });
}

/** The policy one agent's sessions run under: its approval rules, then its tool grants, then allow (a granted tool is allowed unless a rule or its grant says otherwise). */
export function agentPolicy(config: Pick<FrozenAgentConfig, 'approvalPolicy' | 'tools'>): Policy {
    return firstMatch(compilePolicy(config.approvalPolicy), grantPolicy(config.tools), allowAll);
}

/**
 * The policy a session opens with: the agent's own, constrained by the
 * approval rules of every ancestor when the session works a delegated task
 * (`SessionOpenSpec.approvalConstraints`, filled by the router).
 */
export function sessionPolicy(spec: { readonly config: Pick<FrozenAgentConfig, 'approvalPolicy' | 'tools'>; readonly approvalConstraints?: readonly ApprovalRule[] }): Policy {
    const own = agentPolicy(spec.config);
    if (!spec.approvalConstraints?.length) return own;
    return constrainPolicy(own, compilePolicy(spec.approvalConstraints));
}

/** The same compile over what an `OpenSpec` carries (#121): what a daemon opens a session with. */
export function sessionPolicyOf(policy: OpenSpecPolicy): Policy {
    return sessionPolicy({ config: { approvalPolicy: policy.rules, tools: policy.grants }, ...(policy.constraints ? { approvalConstraints: policy.constraints } : {}) });
}
