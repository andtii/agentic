/**
 * `sessionPolicyOf` (#121): the compile a daemon runs over what an
 * `OpenSpec.policy` carries is the platform's `sessionPolicy` — rules first
 * match, grants per tool, the ancestors' constraints never widened. The
 * compile itself is covered in `packages/platform/__tests__/policy`
 * (re-exported from here).
 */
import { describe, expect, it } from 'vitest';
import type { OpenSpecPolicy } from '@agentic/core';
import { createGrants, type PolicyContext, type PolicyRequest } from '@sigx/ai-agent';

import { sessionPolicy, sessionPolicyOf } from '../src/index';

const context: PolicyContext = { sessionId: 's1', interactive: true, grants: createGrants(), signal: new AbortController().signal };
const permission = (toolName: string, category?: string): PolicyRequest => ({ kind: 'permission', toolName, source: 'client', ...(category ? { category } : {}) });

describe('sessionPolicyOf', () => {
    it('decides like sessionPolicy over the same rules, grants and constraints', async () => {
        const policy: OpenSpecPolicy = {
            rules: [{ id: 'ask-destructive', match: { categories: ['destructive'] }, outcome: 'ask' }],
            grants: [{ name: 'rm' }, { name: 'ls' }, { name: 'shell', mode: 'deny' }],
            constraints: [{ id: 'no-rm-below-me', match: { tools: ['rm'] }, outcome: 'deny' }]
        };
        const compiled = sessionPolicyOf(policy);
        const reference = sessionPolicy({ config: { approvalPolicy: policy.rules, tools: policy.grants }, approvalConstraints: policy.constraints });
        for (const request of [permission('rm', 'destructive'), permission('mv', 'destructive'), permission('ls', 'read'), permission('shell'), permission('unknown')]) {
            expect(await compiled(request, context)).toEqual(await reference(request, context));
        }
        // The ancestor's deny wins over the agent's ask; the agent's ask stands where the ancestor has no opinion; a denied grant refuses.
        expect(await compiled(permission('rm', 'destructive'), context)).toMatchObject({ type: 'permission', outcome: 'deny', ruleId: 'no-rm-below-me' });
        expect(await compiled(permission('mv', 'destructive'), context)).toBe('ask');
        expect(await compiled(permission('ls', 'read'), context)).toMatchObject({ outcome: 'allow' });
        expect(await compiled(permission('shell'), context)).toMatchObject({ outcome: 'deny', ruleId: 'grant:shell' });
    });

    it('without constraints it is the agent policy alone', async () => {
        const compiled = sessionPolicyOf({ rules: [], grants: [{ name: 'rm', mode: 'ask' }] });
        expect(await compiled(permission('rm', 'destructive'), context)).toBe('ask');
        expect(await compiled(permission('ls'), context)).toMatchObject({ outcome: 'allow' });
        // An input request is never decided by a rule: it goes to the client.
        expect(await compiled({ kind: 'input', source: 'client' }, context)).toBe('ask');
    });
});
