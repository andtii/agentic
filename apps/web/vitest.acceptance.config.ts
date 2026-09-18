import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
import root from '../../vitest.config.ts';
import { TEST_DEV_LOGIN, TEST_SESSION_SECRET, TEST_WORKSPACE_KEK } from './__tests__/workers/secret.ts';

// `pnpm --filter @agentic/web test:acceptance` — the workerd half of the
// acceptance suite (docs/acceptance.md): the scenarios that need the real
// `ActorHost` Durable Objects (daemon sockets on the Machine object, Schedule
// alarms), on the same Miniflare bindings as `test:workers`; the Worker is
// `__tests__/acceptance/worker.ts`. The in-process half (`ac-NN.test.ts(x)`)
// runs under the root vitest config.
export default defineConfig({
    plugins: [
        cloudflareTest({
            main: './__tests__/acceptance/worker.ts',
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: { bindings: { SESSION_SECRET: TEST_SESSION_SECRET, WORKSPACE_KEK: TEST_WORKSPACE_KEK, AGENTIC_DEV_LOGIN: TEST_DEV_LOGIN } }
        })
    ],
    define: { __DEV__: 'true' },
    resolve: { alias: root.resolve?.alias },
    test: {
        globals: true,
        // Several Durable Object hops per scenario run past the 5 s default on the slower Windows runner.
        testTimeout: 30_000,
        include: ['__tests__/acceptance/**/*.workers.test.ts']
    }
});
