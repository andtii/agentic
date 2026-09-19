import { defineLibConfig } from '@sigx/vite/lib';
import type { ConfigEnv, UserConfig } from 'vite';

const base = defineLibConfig({
    entry: { index: 'src/index.ts', 'claude-code': 'src/claude-code/index.ts', 'copilot-cli': 'src/copilot-cli/index.ts' },
    // The Claude Agent SDK and the Copilot SDK stay runtime dependencies (each ships its CLI per platform): never bundled.
    external: [/@sigx\/.*/, /@agentic\/.*/, /^node:/, /^@anthropic-ai\/claude-agent-sdk/, /^@github\/copilot-sdk/],
    root: import.meta.url
}) as (env: ConfigEnv) => UserConfig;

export default (env: ConfigEnv): UserConfig => base(env);
