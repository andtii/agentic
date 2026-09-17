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
 * Kit import type-only: this entry loads in Node without the kit's barrel.
 */
import type { DesignSystemInput } from '@sigx/zero-kit';
import { registerThemes } from '@sigx/zero/theme';
import { recipes as fragmentRecipes } from '../fragment/recipes.js';
import { overriddenRecipes } from './overrides.js';
import { tokens, system, type Roles } from './tokens.js';

export { tokens, system, custom, palette, AGENT_HUES, THEME, TONES, KINDS, AG_MODIFIERS } from './tokens.js';
export type { Roles } from './tokens.js';
export { overriddenRecipes, withOverride } from './overrides.js';

export const designSystem: DesignSystemInput<Roles, typeof system> = {
    name: 'agentic',
    tokens,
    recipes: [...overriddenRecipes, ...fragmentRecipes]
};

export default designSystem;

/** Seed zero's theme registry — once per entry, before anything reads `useTheme()`. */
export function installThemes(): void {
    registerThemes(tokens);
}
