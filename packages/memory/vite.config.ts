import { defineLibConfig } from '@sigx/vite/lib';
import type { ConfigEnv, UserConfig } from 'vite';

const base = defineLibConfig({
    entry: { index: 'src/index.ts', testing: 'src/testing/index.ts' },
    external: [/@sigx\/.*/, /@agentic\/.*/, /^node:/],
    root: import.meta.url
}) as (env: ConfigEnv) => UserConfig;

export default (env: ConfigEnv): UserConfig => base(env);
