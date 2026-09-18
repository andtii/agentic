import { defineLibConfig } from '@sigx/vite/lib';
import type { ConfigEnv, UserConfig } from 'vite';

const base = defineLibConfig({
    entry: { index: 'src/index.ts', 'claude-code': 'src/claude-code/index.ts' },
    // The Claude Agent SDK stays a runtime dependency (it ships the CLI per platform): never bundled.
    external: [/@sigx\/.*/, /@agentic\/.*/, /^node:/, /^@anthropic-ai\/claude-agent-sdk/],
    root: import.meta.url
}) as (env: ConfigEnv) => UserConfig;

export default (env: ConfigEnv): UserConfig => base(env);
