import { test, expect } from '@playwright/test';
import { fetchTransport } from '@sigx/actors/client';

/**
 * Demo 1 (issue #35): user ↔ platform-managed Anthropic agent in the web UI
 * on Cloudflare. Runs ONLY through `playwright.demo1.config.ts`
 * (`smoke:demo1`) against a deployed Worker; the default e2e config ignores
 * this file.
 *
 * Environment:
 *   BASE_URL           the Worker (the config refuses to start without it)
 *   AGENTIC_DEV_LOGIN  the preview's dev-login secret — the walk-through signs
 *                      in through `POST /auth/dev-login` (preview-only; GitHub
 *                      OAuth cannot run headless)
 *   ANTHROPIC_API_KEY  a real key, in the RUNNER's environment: the Worker holds
 *                      none (#231), so the walk-through stores it as the fresh
 *                      workspace's `anthropic-api-key` secret, as
 *                      `/plugins/anthropic-api` does
 *   DEMO1_USER         optional; default: a fresh `demo1-<stamp>` identity, so the
 *                      roster starts empty and the recording shows the whole flow
 *
 * What the recording shows: an empty roster → "New agent" → Ada on the
 * platform runtime → her Config tab, a saved version → "Start chat" → a
 * message → Ada's answer streaming in.
 */
const token = process.env.AGENTIC_DEV_LOGIN;
const apiKey = process.env.ANTHROPIC_API_KEY;
const user = process.env.DEMO1_USER ?? `demo1-${Date.now().toString(36)}`;
const PROMPT = 'Say hello in exactly five words.';

test('demo 1: sign in, create an agent on anthropic-api, chat with it, watch the answer stream', async ({ page }) => {
    test.skip(!token, 'AGENTIC_DEV_LOGIN is not set: the preview dev login cannot be used');
    test.skip(!apiKey, 'ANTHROPIC_API_KEY is not set in this shell: it becomes the workspace key the agent answers with');

    // Sign in through the preview-only door; the session cookie lands in this context.
    const login = await page.request.post('/auth/dev-login', { data: { token, user } });
    expect(login.status(), 'dev login (is AGENTIC_DEV_LOGIN set on the Worker, and does it match?)').toBe(200);
    const { principal } = (await login.json()) as { principal: { userId: string; workspaceId: string } };
    expect(principal.workspaceId).toBe(`dev_${user}`);

    // The workspace's own Anthropic key (#231), stored the way `/plugins/anthropic-api` stores it: `Registry.setSecret` over the actor mount.
    const origin = new URL(process.env.BASE_URL!).origin;
    const cookie = (login.headers()['set-cookie'] ?? '').split(';')[0]!;
    const registry = { type: 'Registry', key: `${principal.workspaceId}:registry` };
    const transport = fetchTransport({ endpoint: `${origin}/_sigx/actor`, headers: { cookie, origin } });
    await transport.call(`${registry.type}#setSecret`, [registry.key, 'anthropic-api-key', apiKey], { ref: registry });

    // The roster, live: nothing yet for a fresh identity.
    await page.goto('/agents');
    await expect(page.locator('[data-page-title]')).toHaveText('Agents');
    await expect(page.locator('[data-page="agents"]')).not.toHaveAttribute('aria-busy', 'true');

    // New agent → Ada, on the platform runtime.
    await page.getByRole('button', { name: 'New agent' }).click();
    const dialog = page.locator('[data-new-agent-fields]');
    await expect(dialog).toBeVisible();
    await dialog.locator('input[name="agent-name"]').fill('Ada');
    await dialog.locator('input[name="agent-role"]').fill('Demo assistant');
    await page.getByRole('button', { name: 'Create agent' }).click();

    // Her page opens on Config; the form is bound to the stored config, v1 in the rail.
    await expect(page).toHaveURL(/\/agents\/[^/?]+\?tab=config$/);
    const agentId = new URL(page.url()).pathname.split('/').pop()!;
    await expect(page.locator('[data-agent-name]')).toHaveText('Ada');
    await expect(page.locator('[data-agent-role]')).toHaveText('Demo assistant');
    await expect(page.locator('[role="tab"][aria-selected="true"]')).toHaveText('Config');
    const form = page.locator('form[data-form="agent"]');
    await expect(form.locator('input[name="name"]')).toHaveValue('Ada');
    await expect(form.locator('select[name="runtime"]')).toHaveValue('anthropic-api');
    const versions = page.locator('[data-versions-list] [data-scope="ag-version"][data-part="root"]');
    await expect(versions).toHaveCount(1);

    // A save is a new version on the Agent actor.
    await form.locator('textarea[name="instructions"]').fill('Be brief. Answer in one sentence, no preamble.');
    await expect(page.locator('[data-save-card]')).toBeVisible();
    await page.locator('[data-save-card] input[name="reason"]').fill('Demo 1: first instructions');
    await page.locator('[data-save-card] button[type="submit"]').click();
    await expect(versions).toHaveCount(2);
    await expect(page.locator('[data-save-card]')).toHaveCount(0);
    await expect(page.locator('[data-save-error]')).toHaveCount(0);

    // Start chat → a direct chat with Ada.
    await page.getByRole('button', { name: 'Start chat' }).click();
    await expect(page).toHaveURL(/\/chats\/[^/?]+$/);
    const composer = page.locator('[data-scope="ai-composer"]');
    await expect(composer.locator('[data-part="addressing"]')).toContainText('Ada');
    await expect(page.locator('[data-chat-row][data-current] [data-chat-title]')).toHaveText('Ada');

    // Post; the answer streams in from the platform-managed session.
    await composer.locator('textarea').fill(PROMPT);
    await composer.locator('button[type="submit"]').click();
    const messages = page.locator('[data-scope="ai-message"][data-part="root"]');
    await expect(messages.first().locator('[data-part="body"]')).toContainText(PROMPT);
    await expect(page.locator('[data-chat-error]')).toHaveCount(0);
    // The first message names the chat at once (#460); Ada's reply may replace it with a generated title, never with 'Ada' again.
    const title = page.locator('[data-chat-row][data-current] [data-chat-title]');
    await expect(title).toHaveText(PROMPT);

    // Ada's row appears while her turn is still running (the streaming pill), then settles with text.
    const ada = messages.filter({ has: page.locator('[data-part="name"]', { hasText: 'Ada' }) }).first();
    await expect(ada, 'Ada answers (is the ANTHROPIC_API_KEY stored above a working key?)').toBeVisible({ timeout: 120_000 });
    const sawStreaming = await ada.locator('[data-scope="ag-pill"][data-status="streaming"]').isVisible().catch(() => false);
    await expect(ada.locator('[data-part="body"]')).not.toHaveText('', { timeout: 120_000 });
    await expect(ada.locator('[data-scope="ag-pill"][data-status="streaming"]')).toHaveCount(0, { timeout: 120_000 });
    const answer = (await ada.locator('[data-part="body"]').innerText()).trim();
    expect(answer.length).toBeGreaterThan(0);
    expect(answer.startsWith('echo:')).toBe(false);
    console.log(`[demo1] agent ${agentId} answered${sawStreaming ? ' (streaming observed)' : ''}: ${answer}`);
    await expect(page.locator('[data-chat-error]')).toHaveCount(0);
    await expect(title).not.toHaveText('Ada');
    console.log(`[demo1] chat titled: ${(await title.innerText()).trim()}`);
});
