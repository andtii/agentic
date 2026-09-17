import { defineConfig, devices } from '@playwright/test';

/**
 * The e2e suite at the three widths the handoff distinguishes
 * (`docs/design/HANDOFF.md` → "Responsive behaviour"): 400 px (the phone
 * regime: app bar, drawer, stacked tables, docked composer), 1024 px (the
 * sidebar stays, the rails drop under the main column) and 1280 px (as
 * drawn). Specs pick their regime with `test.skip` on the viewport.
 *
 * Runs against the Vite dev server (`node server.mjs`), so `@agentic/ui`
 * must be built first (`pnpm --filter @agentic/ui build`) — the app resolves
 * it through its package `exports`. Browsers: `pnpm exec playwright install
 * chromium` once. CI runs it in the `e2e` job (`.github/workflows/ci.yml`);
 * locally `pnpm --filter @agentic/web test:e2e` (all projects) or
 * `e2e:mobile` (the phone only).
 */
const port = Number(process.env.PORT) || 4173;
const baseURL = `http://localhost:${port}`;

export default defineConfig({
    testDir: './e2e',
    // `demo1.spec.ts` runs against a deployed Worker through `playwright.demo1.config.ts` (`smoke:demo1`, #35), never here.
    testIgnore: /demo1\.spec\.ts$/,
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
        { name: 'phone-400', use: { ...devices['Desktop Chrome'], viewport: { width: 400, height: 800 }, hasTouch: true } },
        { name: 'tablet-1024', use: { ...devices['Desktop Chrome'], viewport: { width: 1024, height: 800 } } },
        { name: 'desktop-1280', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } }
    ]
});
