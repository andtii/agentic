import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import root from '../../vitest.config.ts';

const __dirname = import.meta.dirname;
const rootAliases = Array.isArray(root.resolve?.alias) ? root.resolve.alias : [];

// `pnpm --filter @agentic/web test:node` — the SAME acceptance suite as `test:workers`
// (`__tests__/workers/*.test.ts`), against the Node host (`apps/node`, `createNodeHost`) on an
// in-memory SQLite database instead of the `ActorHost` Durable Object inside workerd (#995).
// `cloudflare:test` is the Node stand-in (`__tests__/node/cloudflare-test.ts`); a test that asserts
// something only a Durable Object has skips here on `onWorkerd` (`__tests__/workers/host-kind.ts`).
export default defineConfig({
    define: { __DEV__: 'true' },
    resolve: {
        alias: [{ find: /^cloudflare:test$/, replacement: resolve(__dirname, '__tests__/node/cloudflare-test.ts') }, ...rootAliases]
    },
    test: {
        globals: true,
        environment: 'node',
        // The same budget as the workers pool: a test drives several actor hops.
        testTimeout: 30_000,
        include: ['__tests__/workers/**/*.test.ts']
    }
});
