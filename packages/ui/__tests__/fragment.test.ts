/**
 * The fragment, held to the checks `sigx zero:fragment` would run once it
 * ships (andtii/zero-wip#482 — the installed kit has no such command yet): the
 * `version` literal against the kit's `FRAGMENT_VERSION`, the merge into the
 * installed `@sigx/zero` manifest (which enforces the governed flag / state
 * / placement vocabularies and the part tree), the recipe pack confined to
 * the scopes and parts the fragment declares, the pack compiling under the
 * recommended vocabulary, the `"sigx-zero"` discovery field, and the root
 * export carrying `componentExportName(scope)` for every scope.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAGMENT_VERSION, componentExportName, defineTokens, mergeManifests, tokenVocabulary, validateRecipes, type ZeroManifest } from '@sigx/zero-kit';
import { fragment, recipes, SCOPES } from '../src/fragment';
import * as ui from '../src';

const zeroManifest = JSON.parse(readFileSync(fileURLToPath(import.meta.resolve('@sigx/zero/manifest.json')), 'utf8')) as ZeroManifest;
// A path, not `new URL(...)`: happy-dom replaces the global URL, which node:fs refuses.
const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as Record<string, unknown>;

describe('the ai-* fragment', () => {
    it('declares the fragment contract version the installed kit understands', () => {
        expect(fragment.version).toBe(FRAGMENT_VERSION);
        expect(fragment.package).toBe('@agentic/ui');
    });

    it('owns the six scopes of the architecture, vendor-prefixed', () => {
        expect(SCOPES).toEqual(['ai-thread', 'ai-message', 'ai-tool-call', 'ai-reasoning', 'ai-approval', 'ai-composer']);
        for (const scope of SCOPES) expect(scope.startsWith('ai-')).toBe(true);
    });

    it('merges into the installed @sigx/zero manifest — governed states, flags, placements, part tree', () => {
        const merged = mergeManifests(zeroManifest, fragment);
        expect(merged.components.length).toBe(zeroManifest.components.length + fragment.components.length);
        for (const c of merged.components.slice(zeroManifest.components.length)) expect(c.package).toBe('@agentic/ui');
        // The tool card's lifecycle, spelled in the governed vocabulary.
        const toolCall = merged.components.find((c) => c.scope === 'ai-tool-call')!;
        expect(toolCall.parts.find((p) => p.name === 'root')!.states).toEqual(['loading', 'active', 'complete', 'error', 'closed']);
    });

    it('styles only the scopes and parts it declares, and validates under the recommended vocabulary', () => {
        const merged = mergeManifests(zeroManifest, fragment);
        for (const recipe of recipes) {
            expect(SCOPES).toContain(recipe.component);
            const anatomy = fragment.components.find((c) => c.scope === recipe.component)!;
            const parts = new Set(anatomy.parts.map((p) => p.name));
            for (const part of Object.keys(recipe.parts)) expect(parts.has(part), `${recipe.component}.${part}`).toBe(true);
        }
        const issues = validateRecipes(recipes, merged, tokenVocabulary(defineTokens({ themes: {}, defaultLight: 'light' } as never)));
        expect(issues.filter((i) => i.level === 'error')).toEqual([]);
    });

    it('styles every declared state distinctly enough to be listed', () => {
        for (const anatomy of fragment.components) {
            const recipe = recipes.find((r) => r.component === anatomy.scope)!;
            for (const part of anatomy.parts) {
                for (const state of part.states ?? []) {
                    expect(recipe.parts[part.name]?.states?.[state], `${anatomy.scope}.${part.name}[${state}]`).toBeDefined();
                }
            }
        }
    });

    it('is discoverable through the "sigx-zero" package.json field and the ./fragment export', () => {
        expect(pkg['sigx-zero']).toEqual({ fragment: './dist/fragment.js', requires: expect.any(String) });
        expect((pkg.exports as Record<string, unknown>)['./fragment']).toBeDefined();
    });

    it('exports componentExportName(scope) from the package root for every scope', () => {
        for (const scope of SCOPES) {
            const name = componentExportName(scope);
            expect(typeof (ui as Record<string, unknown>)[name], name).toBe('function');
        }
    });
});
