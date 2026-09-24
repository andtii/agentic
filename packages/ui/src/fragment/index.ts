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
import { aiComposerAnatomy } from '../composer/anatomy.js';
import { aiApprovalAnatomy, aiMessageAnatomy, aiQuestionAnatomy, aiReasoningAnatomy, aiThreadAnatomy, aiToolCallAnatomy } from '../thread/anatomy.js';
import { kitAnatomies } from '../kit/anatomy.js';
import { fragmentCss as rawFragmentCss, recipes as transcriptRecipes } from './recipes.js';
import { recipes as kitRecipes } from '../kit/recipes.js';
import { codeAnatomies } from '../code/anatomy.js';
import { codeRecipes } from '../code/recipes.js';
import { FALLBACKS, withFallbacks } from './fallbacks.js';

/** The keyframes the streaming dot pulses on — raw CSS a design system appends verbatim (`DesignSystemInput.css`). */
export const fragmentCss = withFallbacks(rawFragmentCss, FALLBACKS);

/**
 * The recipe pack: the transcript's six scopes, the kit's `ag-*` scopes and
 * the session files ones (#563). Every bare `var()` of the kit vocabulary or
 * an `--ag-*` token carries a fallback (`fallbacks.ts`), so the pack paints
 * on a target that defines none of them.
 */
export const recipes = withFallbacks([...transcriptRecipes, ...kitRecipes, ...codeRecipes], FALLBACKS);

/**
 * The manifest fragment: `mergeManifests(zeroManifest, fragment)` (or
 * `--extra-manifest` pointing at the JSON copy) is how a design system opts
 * into covering these scopes.
 */
export const fragment = {
    version: FRAGMENT_VERSION,
    package: '@agentic/ui',
    components: [
        aiThreadAnatomy.toJSON(),
        aiMessageAnatomy.toJSON(),
        aiToolCallAnatomy.toJSON(),
        aiReasoningAnatomy.toJSON(),
        aiApprovalAnatomy.toJSON(),
        aiQuestionAnatomy.toJSON(),
        aiComposerAnatomy.toJSON(),
        ...kitAnatomies.map((a) => a.toJSON()),
        ...codeAnatomies.map((a) => a.toJSON())
    ]
};

/** Every scope this package owns — what the recipe pack may style. */
export const SCOPES = fragment.components.map((c) => c.scope);
