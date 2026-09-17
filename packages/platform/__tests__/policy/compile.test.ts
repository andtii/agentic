/**
 * `compilePolicy` and friends (AGT-04, COL-10, AC-12): approval rules first
 * match, tool grants per tool, and a delegated session's policy constrained
 * by its ancestors' rules — never wider.
 */
import { describe, expect, it } from 'vitest';
import type { ApprovalRule } from '@agentic/core';
import { createGrants, type PolicyContext, type PolicyRequest } from '@sigx/ai-agent';

import { agentPolicy, compilePolicy, constrainPolicy, grantPolicy, ruleMatches, sessionPolicy } from '../../src/policy/index';

const context: PolicyContext = { sessionId: 's1', interactive: true, grants: createGrants(), signal: new AbortController().signal };
const permission = (toolName: string, extra: Partial<PolicyRequest> = {}): PolicyRequest => ({ kind: 'permission', toolName, source: 'client', ...extra });
const input: PolicyRequest = { kind: 'input', source: 'client' };

const rules: ApprovalRule[] = [
    { id: 'no-shell', match: { tools: ['shell'] }, outcome: 'deny' },
    { id: 'ask-writes', match: { categories: ['write', 'destructive'] }, outcome: 'ask' },
    { id: 'mcp-once', match: { source: 'mcp' }, outcome: 'allow', scope: 'session' }
];

describe('ruleMatches', () => {
    it('matches on every present field and an empty match covers everything', () => {
        expect(ruleMatches(rules[0]!, permission('shell'))).toBe(true);
        expect(ruleMatches(rules[0]!, permission('ls'))).toBe(false);
        expect(ruleMatches(rules[1]!, permission('edit', { category: 'write' }))).toBe(true);
        expect(ruleMatches(rules[1]!, permission('edit'))).toBe(false);
        expect(ruleMatches(rules[2]!, permission('x', { source: 'mcp' }))).toBe(true);
        expect(ruleMatches(rules[2]!, permission('x', { source: 'native' }))).toBe(false);
        expect(ruleMatches({ id: 'all', match: {}, outcome: 'ask' }, permission('anything'))).toBe(true);
    });
});

describe('compilePolicy', () => {
    it('first match decides, carries the rule id and scope, and has no opinion otherwise', async () => {
        const policy = compilePolicy(rules);
        expect(await policy(permission('shell'), context)).toEqual({ type: 'permission', outcome: 'deny', scope: 'once', ruleId: 'no-shell', message: 'denied by approval rule "no-shell"' });
        expect(await policy(permission('edit', { category: 'destructive' }), context)).toBe('ask');
        expect(await policy(permission('fetch', { source: 'mcp' }), context)).toEqual({ type: 'permission', outcome: 'allow', scope: 'session', ruleId: 'mcp-once' });
        expect(await policy(permission('ls'), context)).toBeUndefined();
        expect(await policy(input, context)).toBeUndefined();
    });
});

describe('grantPolicy', () => {
    it('ask asks, deny denies, allow allows, and an ungranted tool gets no opinion', async () => {
        const policy = grantPolicy([{ name: 'memory_search' }, { name: 'delegate', mode: 'ask' }, { name: 'shell', mode: 'deny' }]);
        expect(await policy(permission('memory_search'), context)).toMatchObject({ type: 'permission', outcome: 'allow', ruleId: 'grant:memory_search' });
        expect(await policy(permission('delegate'), context)).toBe('ask');
        expect(await policy(permission('shell'), context)).toMatchObject({ type: 'permission', outcome: 'deny' });
        expect(await policy(permission('other'), context)).toBeUndefined();
    });
});

describe('constrainPolicy', () => {
    it('the stricter side wins: an ancestor deny or ask can tighten, never widen', async () => {
        const child = compilePolicy([{ id: 'child-allow', match: { tools: ['shell', 'edit'] }, outcome: 'allow' }]);
        const parent = compilePolicy([
            { id: 'parent-deny', match: { tools: ['shell'] }, outcome: 'deny' },
            { id: 'parent-ask', match: { tools: ['edit'] }, outcome: 'ask' }
        ]);
        const policy = constrainPolicy(child, parent);
        expect(await policy(permission('shell'), context)).toMatchObject({ outcome: 'deny', ruleId: 'parent-deny' });
        expect(await policy(permission('edit'), context)).toBe('ask');
        // Where the constraint has no opinion the child's own answer stands; where the child has none the constraint decides.
        expect(await policy(permission('ls'), context)).toBeUndefined();
        const loose = constrainPolicy(compilePolicy([]), compilePolicy([{ id: 'p-allow', match: { tools: ['ls'] }, outcome: 'allow' }]));
        expect(await loose(permission('ls'), context)).toMatchObject({ outcome: 'allow', ruleId: 'p-allow' });
        // A child deny is not loosened by a parent allow.
        const strict = constrainPolicy(compilePolicy([{ id: 'c-deny', match: { tools: ['ls'] }, outcome: 'deny' }]), compilePolicy([{ id: 'p-allow', match: { tools: ['ls'] }, outcome: 'allow' }]));
        expect(await strict(permission('ls'), context)).toMatchObject({ outcome: 'deny', ruleId: 'c-deny' });
    });
});

describe('agentPolicy / sessionPolicy', () => {
    const config = { approvalPolicy: [{ id: 'ask-delegate', match: { tools: ['delegate'] }, outcome: 'ask' as const }], tools: [{ name: 'delegate' }, { name: 'memory_search' }, { name: 'shell', mode: 'deny' as const }] };

    it('rules, then grants, then allow', async () => {
        const policy = agentPolicy(config);
        expect(await policy(permission('delegate'), context)).toBe('ask');
        expect(await policy(permission('shell'), context)).toMatchObject({ outcome: 'deny' });
        expect(await policy(permission('memory_search'), context)).toMatchObject({ outcome: 'allow' });
        expect(await policy(permission('connector_tool'), context)).toMatchObject({ type: 'permission', outcome: 'allow', ruleId: 'allowAll' });
    });

    it('a delegated session is the agent policy constrained by the chain', async () => {
        expect(await sessionPolicy({ config })(permission('memory_search'), context)).toMatchObject({ outcome: 'allow' });
        const constrained = sessionPolicy({ config, approvalConstraints: [{ id: 'grandparent', match: { tools: ['memory_search'] }, outcome: 'deny' }] });
        expect(await constrained(permission('memory_search'), context)).toMatchObject({ outcome: 'deny', ruleId: 'grandparent' });
        expect(await constrained(permission('delegate'), context)).toBe('ask');
    });
});
