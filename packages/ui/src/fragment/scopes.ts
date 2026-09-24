/**
 * The pack's declines (`sigx-zero` fragment `scopes` export, zero 0.5): the
 * axes a scope of this package accepts at runtime but never wires, declared
 * out of existence instead of padded with rules that only quiet the guards.
 *
 * - No scope renders `data-color` or `data-size`: state rides `data-state`,
 *   `data-tone`, `data-kind` and modifiers, and every size is the handoff's
 *   one size. So every scope declines `colors` and `sizes`.
 * - A few scopes carry `data-tone` / `data-kind` on a PART (a diff row, a tree
 *   dot, a ring) or as a private layout switch (`ag-code`'s `data-kind` is
 *   viewer or diff), never as the design system's `tone` / `kind` axis on the
 *   root; they decline the axis too, so the audit does not read those
 *   selectors as an axis with holes in it.
 *
 * Only empty lists (the kit refuses anything else): narrowing an axis to
 * values is the adopting design system's call, which `agentic` makes in
 * `kit/vocabulary.ts` / `code/vocabulary.ts`. Pure data.
 */
import type { ScopeVocabulary } from '@sigx/zero-kit';
import { aiComposerAnatomy } from '../composer/anatomy.js';
import { aiApprovalAnatomy, aiMessageAnatomy, aiQuestionAnatomy, aiReasoningAnatomy, aiThreadAnatomy, aiToolCallAnatomy } from '../thread/anatomy.js';
import { kitAnatomies } from '../kit/anatomy.js';
import { codeAnatomies } from '../code/anatomy.js';
import { aiFormAnatomy } from '../forms/anatomy.js';
import { aiShellAnatomy } from '../shell/anatomy.js';

/** Every anatomy the fragment declares, in the fragment's order. */
export const anatomies = [
    aiThreadAnatomy,
    aiMessageAnatomy,
    aiToolCallAnatomy,
    aiReasoningAnatomy,
    aiApprovalAnatomy,
    aiQuestionAnatomy,
    aiComposerAnatomy,
    ...kitAnatomies,
    ...codeAnatomies,
    aiFormAnatomy,
    aiShellAnatomy
];

/** Scopes whose `data-tone` / `data-kind` selectors are part-level or private, never the axis. */
const PART_AXES: Record<string, Record<string, readonly string[]>> = {
    'ag-code': { tone: [], kind: [] },
    'ag-file-tree': { tone: [] },
    'ag-quota-rings': { tone: [] }
};

export const scopes: Record<string, ScopeVocabulary> = Object.fromEntries(
    anatomies.map((a) => [a.scope, { colors: [], sizes: [], ...(PART_AXES[a.scope] ? { axes: PART_AXES[a.scope] } : {}) }])
);
