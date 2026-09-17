import { defineConfig, devices } from '@playwright/test';

/**
 * `pnpm --filter @agentic/web smoke:demo1` — the scripted demo 1 walk-through
 * (issue #35) against a DEPLOYED Worker, never a dev server:
 *
 *     BASE_URL=https://agentic-web-preview.<account>.workers.dev \
 *     AGENTIC_DEV_LOGIN=<the preview's dev-login secret> \
 *     pnpm --filter @agentic/web smoke:demo1
 *
 * One desktop project, one worker, no retries (a flake is a finding), video
 * always on — the recording under `test-results/demo1/` is what the issue
 * asks to attach. See `docs/runbook.md` → "Demo 1 smoke".
 */
const baseURL = process.env.BASE_URL;
if (!baseURL) throw new Error('smoke:demo1 needs BASE_URL (the preview Worker, e.g. https://agentic-web-preview.<account>.workers.dev)');

export default defineConfig({
    testDir: './e2e',
    testMatch: /demo1\.spec\.ts$/,
    outputDir: './test-results/demo1',
    fullyParallel: false,
    workers: 1,
    retries: 0,
    timeout: 180_000,
    reporter: [['list'], ['html', { outputFolder: './playwright-report/demo1', open: 'never' }]],
    use: {
        baseURL,
        video: 'on',
        trace: 'retain-on-failure',
        // A Worker's TLS is real; `wrangler dev` over plain http://localhost is still a secure context for `__Host-` cookies.
        ignoreHTTPSErrors: false
    },
    projects: [{ name: 'demo1-desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } }]
});
