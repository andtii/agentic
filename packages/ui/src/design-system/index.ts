/**
 * `@agentic/ui/design-system` — the `agentic` design system as data.
 *
 * Derived from zero-daisyui's design system with the kit's
 * `extendDesignSystem`: the `control-room` tokens (`tokens.ts`) patched over
 * daisy's, daisy's recipes re-tuned by one `RecipePatch` per scope
 * (`patches/<scope>.ts`), and the `ai-*` fragment's, the kit's and the code
 * surfaces' recipe packs added. Compiled by `scripts/build-design-system.mjs`
 * through `runStandardBuild` into `dist/ds/**` (`@agentic/ui/css`,
 * `/css/tokens`, `/register`, `/manifest.json`); validated in the web app's
 * build by `sigx zero:validate` with the fragment merged.
 *
 * The derivation regenerates the layout tier (Stack / Row / Grid / … recipes
 * and CSS) from the derived tokens' spacing ramp and breakpoints, and carries
 * daisy's vendor-named `api`. It records what each patch touched
 * (`derivedFrom`), so the validator warns when a patch reaches a name daisy
 * keeps private rather than one of its declared `hooks`.
 *
 * The kit is reached only through `@sigx/zero-kit/define`, its node:-free
 * authoring subpath, so this entry still loads in Node without the kit's
 * barrel; the call is `@__PURE__` so an app importing only `installThemes`
 * tree-shakes it away.
 */
import { extendDesignSystem, type DesignSystemExtension } from '@sigx/zero-kit/define';
import { designSystem as daisy } from '@sigx/zero-daisyui/design-system';
import { registerThemes } from '@sigx/zero/theme';
import { fragmentCss, recipes as fragmentRecipes } from '../fragment/recipes.js';
import { kitCss } from '../kit/css.js';
import { recipes as kitRecipes } from '../kit/recipes.js';
import { codeCss } from '../code/css.js';
import { codeRecipes } from '../code/recipes.js';
import { patches } from './patches/index.js';
import { tokens } from './tokens.js';

export { tokens, system, custom, contrast, palette, AGENT_HUES, THEME, TONES, KINDS, AG_MODIFIERS } from './tokens.js';
export type { Roles } from './tokens.js';
export { patches } from './patches/index.js';

/**
 * The extension over daisy. `tokens` is already the whole `control-room`
 * declaration (it stands alone for `installThemes`), so as a patch it only
 * has to drop what daisy has and agentic does not: daisy's themes and its
 * dark default.
 */
function extension(): DesignSystemExtension {
    const dropThemes = Object.fromEntries(Object.keys(daisy.tokens.themes).map((name) => [name, null]));
    return {
        name: 'agentic',
        tokens: { ...tokens, defaultDark: null, themes: { ...dropThemes, ...tokens.themes } },
        recipes: patches,
        addRecipes: [...fragmentRecipes, ...kitRecipes, ...codeRecipes],
        css: [kitCss, codeCss, fragmentCss]
    };
}

export const designSystem = /* @__PURE__ */ extendDesignSystem(daisy, /* @__PURE__ */ extension());

export default designSystem;

/** Seed zero's theme registry — once per entry, before anything reads `useTheme()`. */
export function installThemes(): void {
    registerThemes(tokens);
}
