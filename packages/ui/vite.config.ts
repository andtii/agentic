import { defineLibConfig } from '@sigx/vite/lib';
import type { ConfigEnv, UserConfig } from 'vite';

// Three entries on purpose: `fragment` (the manifest fragment and the recipe
// pack) and `design-system` (tokens + every recipe) are pure data, so
// `scripts/build-design-system.mjs` and `sigx zero:validate` import them in
// Node without loading the components.
const base = defineLibConfig({
    entry: { index: 'src/index.ts', fragment: 'src/fragment/index.ts', 'design-system': 'src/design-system/index.ts' },
    external: [/@sigx\/.*/, /@agentic\/.*/, /^node:/, 'sigx', 'sigx/jsx-runtime', 'sigx/jsx-dev-runtime'],
    jsx: true,
    importSource: '@sigx/runtime-core',
    root: import.meta.url
}) as (env: ConfigEnv) => UserConfig;

export default (env: ConfigEnv): UserConfig => base(env);
