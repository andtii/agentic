import { defineLibConfig } from '@sigx/vite/lib';
import type { ConfigEnv, UserConfig } from 'vite';

const base = defineLibConfig({
    entry: { index: 'src/index.ts', cli: 'src/cli.ts' },
    external: [/@sigx\/.*/, /@agentic\/.*/, /^node:/, 'ws'],
    root: import.meta.url
}) as (env: ConfigEnv) => UserConfig;

export default (env: ConfigEnv): UserConfig => base(env);
