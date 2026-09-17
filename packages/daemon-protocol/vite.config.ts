import { defineLibConfig } from '@sigx/vite/lib';
import type { ConfigEnv, UserConfig } from 'vite';

// Two entries: the envelope (`.`) and the conformance suite (`./testing`),
// each a dev dist and a prod dist; `.d.ts` come from `tsc -p tsconfig.build.json`.
const base = defineLibConfig({
    entry: { index: 'src/index.ts', testing: 'src/testing/index.ts' },
    external: [/@sigx\/.*/, /@agentic\/.*/, /^zod/, /^node:/],
    root: import.meta.url
}) as (env: ConfigEnv) => UserConfig;

export default (env: ConfigEnv): UserConfig => base(env);
