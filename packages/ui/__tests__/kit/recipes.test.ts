/**
 * The kit's declaration, held to the design system: every `ag-*` scope is in
 * the fragment, every tone and every kit modifier is wired by a recipe (the
 * coverage report would otherwise list them "declared but unwired"), the
 * recipes style only declared parts, and the whole compiles with 0 errors.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mergeManifests, validateDesignSystem, type ZeroManifest } from '@sigx/zero-kit';
import { AG_MODIFIERS, KINDS, TONES, designSystem, tokens } from '../../src/design-system';
import { fragment } from '../../src/fragment';
import { kitAnatomies, kitRecipes, kitScopes, NEEDS_KINDS } from '../../src/kit';

const zeroManifest = JSON.parse(readFileSync(fileURLToPath(import.meta.resolve('@sigx/zero/manifest.json')), 'utf8')) as ZeroManifest;

describe('the ag-* kit', () => {
    it('declares eight scopes, every one in the fragment with a recipe and a vocabulary claim', () => {
        const scopes = kitAnatomies.map((a) => a.scope);
        expect(scopes).toEqual(['ag-pill', 'ag-agent-tile', 'ag-env-line', 'ag-needs-item', 'ag-task-node', 'ag-connection', 'ag-version', 'ag-env-card']);
        for (const scope of scopes) {
            expect(fragment.components.some((c) => c.scope === scope), scope).toBe(true);
            expect(kitRecipes.some((r) => r.component === scope), scope).toBe(true);
            expect(kitScopes[scope], scope).toBeDefined();
            expect(tokens.scopes?.[scope], scope).toEqual(kitScopes[scope]);
        }
    });

    it('wires every tone and every kit modifier somewhere', () => {
        const wiredTones = new Set(kitRecipes.flatMap((r) => Object.keys(r.variants?.['tone'] ?? {})));
        for (const tone of TONES) expect(wiredTones.has(tone), tone).toBe(true);
        const wiredMods = new Set(kitRecipes.flatMap((r) => Object.keys(r.modifiers ?? {})));
        for (const mod of AG_MODIFIERS) expect(wiredMods.has(mod), mod).toBe(true);
        // The inbox kinds are wired here; the five failure kinds belong to the states issue.
        const wiredKinds = new Set(kitRecipes.flatMap((r) => Object.keys(r.variants?.['kind'] ?? {})));
        expect([...wiredKinds].sort()).toEqual([...NEEDS_KINDS].sort());
        expect(KINDS.filter((k) => !wiredKinds.has(k))).toEqual(['offline', 'machine', 'auth', 'runtime', 'task']);
    });

    it('styles only declared parts, and the design system validates with 0 errors', () => {
        for (const recipe of kitRecipes) {
            const anatomy = kitAnatomies.find((a) => a.scope === recipe.component)!;
            const parts = new Set<string>(anatomy.partNames());
            for (const part of Object.keys(recipe.parts)) expect(parts.has(part), `${recipe.component}.${part}`).toBe(true);
        }
        const result = validateDesignSystem(designSystem, mergeManifests(zeroManifest, fragment));
        expect(result.errors).toEqual([]);
        // What is left: the failure kinds declared ahead of the states issue.
        expect(result.warnings.map((w) => w.where)).toEqual(['tokens.axes.kind', 'tokens.axes.kind', 'tokens.axes.kind', 'tokens.axes.kind', 'tokens.axes.kind']);
    });
});
