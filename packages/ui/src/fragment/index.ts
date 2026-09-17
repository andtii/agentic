/**
 * The data face of `@agentic/ui` — what a design system consumes.
 *
 * Pure data on purpose: the anatomy imports pull no component code and the
 * kit import is type-only, so a `build.mjs`-style Node script (or
 * `sigx zero:extend`, once a kit carrying it ships — andtii/zero-wip#482)
 * imports this entry without loading the sigx runtime. Declared to the ecosystem through `package.json`'s
 * `"sigx-zero"` field; `dist/fragment.json` is the same fragment as JSON for
 * the `--extra-manifest` path.
 */
import { aiComposerAnatomy } from '../composer/anatomy.js';
import { aiApprovalAnatomy, aiMessageAnatomy, aiReasoningAnatomy, aiThreadAnatomy, aiToolCallAnatomy } from '../thread/anatomy.js';
import { kitAnatomies } from '../kit/anatomy.js';
import { recipes as transcriptRecipes } from './recipes.js';
import { recipes as kitRecipes } from '../kit/recipes.js';

/** The keyframes the streaming dot pulses on — raw CSS a design system appends verbatim (`DesignSystemInput.css`). */
export { fragmentCss } from './recipes.js';

/** The recipe pack: the transcript's six scopes and the kit's `ag-*` scopes. */
export const recipes = [...transcriptRecipes, ...kitRecipes];

/**
 * The manifest fragment: `mergeManifests(zeroManifest, fragment)` (or
 * `--extra-manifest` pointing at the JSON copy) is how a design system opts
 * into covering these scopes.
 *
 * `version` is the fragment contract version this package was built against
 * (`FRAGMENT_VERSION` in `@sigx/zero-kit`) — a literal rather than the
 * constant, because the kit import must stay type-only for this entry to
 * remain loadable without the kit at runtime. `mergeManifests` hard-errors
 * on a mismatch, which is the point: a stale fragment fails by name.
 */
export const fragment = {
    version: 1,
    package: '@agentic/ui',
    components: [
        aiThreadAnatomy.toJSON(),
        aiMessageAnatomy.toJSON(),
        aiToolCallAnatomy.toJSON(),
        aiReasoningAnatomy.toJSON(),
        aiApprovalAnatomy.toJSON(),
        aiComposerAnatomy.toJSON(),
        ...kitAnatomies.map((a) => a.toJSON())
    ]
};

/** Every scope this package owns — what the recipe pack may style. */
export const SCOPES = fragment.components.map((c) => c.scope);
