import { defineLibConfig } from '@sigx/vite/lib';
import type { ConfigEnv, UserConfig } from 'vite';

// `index` is edge-safe (fetch only); `node` spawns processes and is the daemon's entry.
const base = defineLibConfig({
    entry: { index: 'src/index.ts', node: 'src/node/index.ts' },
    external: [/@sigx\/.*/, /@agentic\/.*/, /^node:/],
    root: import.meta.url
}) as (env: ConfigEnv) => UserConfig;

export default (env: ConfigEnv): UserConfig => base(env);
