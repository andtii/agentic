import { defineConfig, devices } from '@playwright/test';

/**
 * Smoke suite for the app shell at the two widths the shell distinguishes:
 * 400px (drawer navigation) and 1280px (sidebar navigation).
 *
 * Runs against the Vite dev server (`node server.mjs`), so `@agentic/ui`
 * must be built first (`pnpm --filter @agentic/ui build`) — the app resolves
 * it through its package `exports`. Browsers: `pnpm exec playwright install
 * chromium` once. Not wired into CI yet (no browser install step there);
 * run it locally with `pnpm --filter @agentic/web test:e2e`.
 */
const port = Number(process.env.PORT) || 4173;
const baseURL = `http://localhost:${port}`;

export default defineConfig({
    testDir: './e2e',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? 'github' : 'list',
    use: { baseURL },
    webServer: {
        command: 'node server.mjs',
        url: baseURL,
        env: { PORT: String(port) },
        reuseExistingServer: !process.env.CI,
        timeout: 120_000
    },
    projects: [
        { name: 'phone-400', use: { ...devices['Desktop Chrome'], viewport: { width: 400, height: 800 } } },
        { name: 'desktop-1280', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } }
    ]
});
