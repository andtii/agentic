/**
 * The fragment's product assertions. The generic checks — the version
 * against `FRAGMENT_VERSION`, the merge into zero's manifest, recipes
 * confined to declared parts, the lynx probe, the `"sigx-zero"` field and
 * the root export names — are `sigx zero:fragment --strict`'s, which the
 * package build runs.
 */
import { describe, it, expect } from 'vitest';
import { fragment, recipes, scopes, SCOPES } from '../src/fragment';

describe('the ai-* fragment', () => {
    it('owns the seven transcript scopes of the architecture and the kit ag-* scopes, vendor-prefixed', () => {
        expect(fragment.package).toBe('@agentic/ui');
        expect(SCOPES.slice(0, 7)).toEqual(['ai-thread', 'ai-message', 'ai-tool-call', 'ai-reasoning', 'ai-approval', 'ai-question', 'ai-composer']);
        expect(SCOPES.slice(7)).toEqual(['ag-env-line', 'ag-needs-item', 'ag-task-node', 'ag-connection', 'ag-version', 'ag-env-card', 'ag-banner', 'ag-workdir', 'ag-workdir-picker', 'ag-readiness', 'ag-secret', 'ag-map-field', 'ag-quota', 'ag-quota-panel', 'ag-quota-rings', 'ag-markdown', 'ag-code', 'ag-status-tile', 'ag-diff-counts', 'ag-changes', 'ag-file-tree', 'ag-find', 'ag-session-bar', 'ag-file-header', 'ag-line-composer', 'ai-form', 'ai-shell']);
        for (const scope of SCOPES) expect(scope).toMatch(/^a[ig]-/);
    });

    it('declares every scope out of the colour and size axes it never wires, and nothing else', () => {
        expect(Object.keys(scopes)).toEqual(SCOPES);
        for (const [scope, entry] of Object.entries(scopes)) {
            expect(entry, scope).toMatchObject({ colors: [], sizes: [] });
            for (const list of Object.values(entry.axes ?? {})) expect(list, scope).toEqual([]);
        }
        // Part-level `data-tone` / `data-kind` (a diff row, a tree dot, a ring; the code surface's viewer / diff switch) is not the axis.
        expect(scopes['ag-code']!.axes).toEqual({ tone: [], kind: [] });
        // No recipe keys the colour axis any more (the thread anchor's was the last).
        for (const recipe of recipes) expect(recipe.variants?.['color'], recipe.component).toBeUndefined();
    });

    it('publishes the pack without breakpoint conditions until zero\'s fragment probe accepts them (signalxjs/zero#225)', () => {
        expect(JSON.stringify(recipes)).not.toMatch(/"below-|"(sm|md|lg|xl)":/);
        // Built-in conditions stay: the reduced-motion stop is part of the pack.
        expect(JSON.stringify(recipes)).toContain('"reduced-motion"');
    });

    it('spells the tool card lifecycle in the governed state vocabulary', () => {
        const toolCall = fragment.components.find((c) => c.scope === 'ai-tool-call')!;
        expect(toolCall.parts.find((p) => p.name === 'root')!.states).toEqual(['loading', 'running', 'paused', 'complete', 'error', 'denied', 'cancelled']);
    });

    it('styles every declared state distinctly enough to be listed', () => {
        for (const anatomy of fragment.components) {
            const recipe = recipes.find((r) => r.component === anatomy.scope)!;
            for (const part of anatomy.parts) {
                for (const state of part.states ?? []) {
                    // Styled, or declared to look like a sibling state on purpose (`sameAs`).
                    const addressed = recipe.parts[part.name]?.states?.[state] ?? recipe.sameAs?.[part.name]?.[state];
                    expect(addressed, `${anatomy.scope}.${part.name}[${state}]`).toBeDefined();
                }
            }
        }
    });
});
