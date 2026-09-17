import { expectTypeOf } from 'vitest';
import type { NewMemoryEntry, Proposal } from '@agentic/core';
import type { DeepKeys, InstructionProposal, PermissionFree, PermissionKey } from '../src/index';

describe('no proposal ever contains permission fields (type level)', () => {
    it('the core Proposal union reaches no permission key', () => {
        expectTypeOf<Extract<DeepKeys<Proposal>, PermissionKey>>().toBeNever();
        expectTypeOf<PermissionFree<Proposal>>().toEqualTypeOf<Proposal>();
    });

    it('PermissionFree rejects a shape that carries one, at any depth', () => {
        expectTypeOf<PermissionFree<{ kind: 'memory'; entry: NewMemoryEntry & { permissions: string[] } }>>().toBeNever();
        expectTypeOf<PermissionFree<{ kind: 'x'; nested: { deeper: readonly { allowedTools: string }[] } }>>().toBeNever();
    });

    it('a proposal literal with a permission field does not type-check', () => {
        const entry: NewMemoryEntry = { kind: 'lesson', text: 'x', tags: [], confidence: 'stated', provenance: { source: 'user' } };
        // @ts-expect-error permissions is not a field of a memory proposal
        const p: Proposal = { kind: 'memory', entry, permissions: ['tools:*'] };
        // @ts-expect-error instructions cannot opt out of review
        const q: InstructionProposal = { kind: 'instruction', patch: 'p', reason: 'r', requiresReview: false };
        void p;
        void q;
    });
});
