/**
 * `@agentic/ui/design-system` — the `agentic` design system as data.
 *
 * zero-daisyui's recipes (re-tuned in `overrides.ts`), the `ai-*` fragment's
 * recipe pack, and the `control-room` tokens (`tokens.ts`). Compiled by
 * `scripts/build-design-system.mjs` through `runStandardBuild` into
 * `dist/ds/**` (`@agentic/ui/css`, `/css/tokens`, `/register`,
 * `/manifest.json`); validated in the web app's build by
 * `sigx zero:validate` with the fragment merged.
 *
 * daisy's `api` is deliberately not carried: its emitter writes a
 * `components` artifact that imports every ecosystem scope from the package
 * that owns it — `@agentic/ui` importing `@agentic/ui`. The app keeps using
 * `@sigx/zero-daisyui/components`, whose vocabulary is a subset of this one.
 *
 * The layout tier (zero 0.3's Stack / Row / Grid / … recipes and CSS) is
 * generated from these tokens' spacing ramp and breakpoints, as daisy's own
 * design system does. The kit is reached only through `@sigx/zero-kit/define`,
 * its node:-free authoring subpath, so this entry still loads in Node without
 * the kit's barrel; the calls are `@__PURE__` so an app importing only
 * `installThemes` tree-shakes them away.
 */
import type { DesignSystemInput } from '@sigx/zero-kit';
import { layoutCss, layoutRecipes } from '@sigx/zero-kit/define';
import { registerThemes } from '@sigx/zero/theme';
import { fragmentCss, recipes as fragmentRecipes } from '../fragment/recipes.js';
import { kitCss } from '../kit/css.js';
import { recipes as kitRecipes } from '../kit/recipes.js';
import { codeCss } from '../code/css.js';
import { codeRecipes } from '../code/recipes.js';
import { overriddenRecipes } from './overrides.js';
import { tokens, system, type Roles } from './tokens.js';

export { tokens, system, custom, palette, AGENT_HUES, THEME, TONES, KINDS, AG_MODIFIERS } from './tokens.js';
export type { Roles } from './tokens.js';
export { overriddenRecipes, withOverride } from './overrides.js';

export const designSystem: DesignSystemInput<Roles, typeof system> = {
    name: 'agentic',
    tokens,
    recipes: [.../* @__PURE__ */ layoutRecipes(tokens), ...overriddenRecipes, ...fragmentRecipes, ...kitRecipes, ...codeRecipes],
    css: [/* @__PURE__ */ layoutCss(tokens), kitCss, codeCss, fragmentCss]
};

export default designSystem;

/** Seed zero's theme registry — once per entry, before anything reads `useTheme()`. */
export function installThemes(): void {
    registerThemes(tokens);
}
