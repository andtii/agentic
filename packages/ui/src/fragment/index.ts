/**
 * The data face of `@agentic/ui` — what a design system consumes.
 *
 * Pure data on purpose: the anatomy imports pull no component code and the
 * kit import is type-only, so a Node script imports this entry without
 * loading the sigx runtime. Declared to the ecosystem through `package.json`'s
 * `"sigx-zero"` field and gated by `sigx zero:fragment --strict` in the build,
 * which also writes `dist/fragment.json` for the `--extra-manifest` path.
 */
import { FRAGMENT_VERSION } from '@sigx/zero/contract';
import { fragmentCss as rawFragmentCss, recipes as transcriptRecipes } from './recipes.js';
import { recipes as kitRecipes } from '../kit/recipes.js';
import { codeRecipes } from '../code/recipes.js';
import { FALLBACKS, withFallbacks } from './fallbacks.js';
import { anatomies } from './scopes.js';
import { withoutBreakpoints } from '../_zero-gaps/pack-breakpoints.js';

/** Raw CSS a design system appends verbatim (`DesignSystemInput.css`) — empty since the recipes express everything (#595). */
export const fragmentCss = withFallbacks(rawFragmentCss, FALLBACKS);

/**
 * The recipe pack: the transcript's seven scopes, the kit's `ag-*` scopes and
 * the session files ones (#563). Every bare `var()` of the kit vocabulary or
 * an `--ag-*` token carries a fallback (`fallbacks.ts`), so the pack paints
 * on a target that defines none of them. Published without the phone
 * regime's breakpoint conditions until zero's fragment probe accepts them
 * (`_zero-gaps/pack-breakpoints.ts`); the `agentic` design system compiles
 * the recipes whole.
 */
export const recipes = withFallbacks(withoutBreakpoints([...transcriptRecipes, ...kitRecipes, ...codeRecipes]), FALLBACKS);

/**
 * The pack's axis declines, `tokens.scopes`-shaped with every list empty —
 * folded into an adopting design system's `tokens.scopes` (never over an
 * entry it wrote itself). See `./scopes.ts`.
 */
export { scopes } from './scopes.js';

/**
 * The manifest fragment: `mergeManifests(zeroManifest, fragment)` (or
 * `--extra-manifest` pointing at the JSON copy) is how a design system opts
 * into covering these scopes. `ai-form` and `ai-shell` are declared for the
 * parts the forms and the shell stamp (their recipes only space the form's
 * button row and draw the shell's brand; the layout is the app's).
 */
export const fragment = {
    version: FRAGMENT_VERSION,
    package: '@agentic/ui',
    components: anatomies.map((a) => a.toJSON())
};

/** Every scope this package owns — what the recipe pack may style. */
export const SCOPES = fragment.components.map((c) => c.scope);
