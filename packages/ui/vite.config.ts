import { defineLibConfig } from '@sigx/vite/lib';
import type { ConfigEnv, UserConfig } from 'vite';

// Two entries on purpose: `fragment` is pure data (the manifest fragment and
// the recipe pack), so a design system's Node build script can import it
// without loading the components or the sigx runtime.
const base = defineLibConfig({
    entry: { index: 'src/index.ts', fragment: 'src/fragment/index.ts' },
    external: [/@sigx\/.*/, /@agentic\/.*/, /^node:/, 'sigx', 'sigx/jsx-runtime', 'sigx/jsx-dev-runtime'],
    jsx: true,
    importSource: '@sigx/runtime-core',
    root: import.meta.url
}) as (env: ConfigEnv) => UserConfig;

export default (env: ConfigEnv): UserConfig => base(env);
