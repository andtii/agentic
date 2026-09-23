import { defineLibConfig } from '@sigx/vite/lib';
import type { ConfigEnv, UserConfig } from 'vite';

// Edge-safe: fetch + WebCrypto only. conduit's `/node` subpath is never imported.
const base = defineLibConfig({
    entry: { index: 'src/index.ts' },
    external: [/@sigx\/.*/, /@agentic\/.*/, /@aigntiq\/.*/, /^node:/],
    root: import.meta.url
}) as (env: ConfigEnv) => UserConfig;

export default (env: ConfigEnv): UserConfig => base(env);
