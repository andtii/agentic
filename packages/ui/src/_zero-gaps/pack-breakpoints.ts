/**
 * zero gap (signalxjs/zero#225): `sigx zero:fragment` fits a pack onto a
 * probe vocabulary that declares no breakpoints, and the fit keeps every `at`
 * condition when none are declared — so a pack recipe keyed `below-md` fails
 * the gate with "unknown condition", although an adopter that declares `md`
 * compiles it fine and one that does not would have it dropped.
 *
 * Until the probe drops them, the PUBLISHED pack (`@agentic/ui/fragment`'s
 * `recipes`) goes out without its breakpoint conditions — what the fit does
 * for an adopter with no ramp — while the `agentic` design system compiles
 * the recipes as written. Delete this file and its one call in
 * `fragment/index.ts` once the probe is fixed.
 */
import type { RecipeInput } from '@sigx/zero-kit';

/** A breakpoint condition: a bare name or `below-<name>`; raw `@` preludes and built-ins (`reduced-motion`, …) are not. */
const BUILTINS = new Set(['reduced-motion', 'hover-none', 'prefers-dark', 'forced-colors', 'print', 'starting-style']);
const isBreakpoint = (key: string): boolean => !key.startsWith('@') && !BUILTINS.has(key);

function strip(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(strip);
    if (!value || typeof value !== 'object') return value;
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
        if (key === 'at' && inner && typeof inner === 'object') {
            const kept = Object.fromEntries(Object.entries(inner).filter(([condition]) => !isBreakpoint(condition)).map(([c, s]) => [c, strip(s)]));
            if (Object.keys(kept).length > 0) out[key] = kept;
            continue;
        }
        out[key] = strip(inner);
    }
    return out;
}

/** The recipes without their breakpoint-keyed `at` entries (see above). */
export function withoutBreakpoints(recipes: readonly RecipeInput[]): RecipeInput[] {
    return recipes.map((r) => strip(r) as RecipeInput);
}
