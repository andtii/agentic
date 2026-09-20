import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const __dirname = import.meta.dirname;
const pkg = (name: string) => resolve(__dirname, `packages/${name}/src/index.ts`);

export default defineConfig({
    define: { __DEV__: 'true' },
    oxc: { jsx: { runtime: 'automatic', importSource: '@sigx/runtime-core' } },
    test: {
        environment: 'happy-dom',
        include: ['packages/**/__tests__/**/*.test.{ts,tsx}', 'apps/**/__tests__/**/*.test.{ts,tsx}'],
        // workerd-only: `pnpm --filter @agentic/web test:workers`, and the `*.workers.test.ts` half of `test:acceptance`
        exclude: ['**/node_modules/**', '**/dist/**', 'apps/web/__tests__/workers/**', '**/*.workers.test.ts'],
        globals: true,
        typecheck: { enabled: true, include: ['packages/**/__tests__/**/*.test-d.ts'] }
    },
    resolve: {
        // longest names first: a string find is a prefix match
        alias: [
            { find: '@agentic/daemon-protocol/testing', replacement: resolve(__dirname, 'packages/daemon-protocol/src/testing/index.ts') },
            { find: '@agentic/daemon-protocol', replacement: pkg('daemon-protocol') },
            { find: '@agentic/platform', replacement: pkg('platform') },
            { find: '@agentic/runtimes/claude-code', replacement: resolve(__dirname, 'packages/runtimes/src/claude-code/index.ts') },
            { find: '@agentic/runtimes/copilot-cli', replacement: resolve(__dirname, 'packages/runtimes/src/copilot-cli/index.ts') },
            { find: '@agentic/runtimes/codex-cli', replacement: resolve(__dirname, 'packages/runtimes/src/codex-cli/index.ts') },
            { find: '@agentic/runtimes', replacement: pkg('runtimes') },
            { find: '@agentic/learning', replacement: pkg('learning') },
            { find: '@agentic/plugins-git', replacement: pkg('plugins-git') },
            { find: '@agentic/memory/testing', replacement: resolve(__dirname, 'packages/memory/src/testing/index.ts') },
            { find: '@agentic/memory', replacement: pkg('memory') },
            { find: '@agentic/core', replacement: pkg('core') },
            { find: '@agentic/ui/design-system', replacement: resolve(__dirname, 'packages/ui/src/design-system/index.ts') },
            { find: '@agentic/ui', replacement: pkg('ui') },
            { find: '@agentic/mcp/node', replacement: resolve(__dirname, 'packages/mcp/src/node/index.ts') },
            { find: '@agentic/mcp', replacement: pkg('mcp') },
            { find: '@agentic/a2a', replacement: pkg('a2a') }
        ]
    }
});
