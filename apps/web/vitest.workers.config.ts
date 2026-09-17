import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
import root from '../../vitest.config.ts';
import { TEST_SESSION_SECRET } from './__tests__/workers/secret.ts';

// `pnpm --filter @agentic/web test:workers` — runs inside workerd (Miniflare)
// with the real `ActorHost` Durable Object on SQLite storage.
export default defineConfig({
    plugins: [
        cloudflareTest({
            main: './__tests__/workers/worker.ts',
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: { bindings: { SESSION_SECRET: TEST_SESSION_SECRET } }
        })
    ],
    define: { __DEV__: 'true' },
    resolve: { alias: root.resolve?.alias },
    test: {
        globals: true,
        // Several Durable Object hops per test run past the 5 s default on the slower Windows runner.
        testTimeout: 30_000,
        include: ['__tests__/workers/**/*.test.ts']
    }
});
