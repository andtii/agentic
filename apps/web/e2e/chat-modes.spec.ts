import { test, expect, type Page } from '@playwright/test';

/**
 * The chat's Focus view (#1058; `docs/design/chat-modes/screenshots/ChatFocus.png`) at every width: the
 * header with the rule's note and the View and Detail controls, the finished turns folded into steps boxes
 * (the one a failure stopped opens itself), the live line under the last turn — and no horizontal scroll.
 * The screenshots land in the test output for a by-eye comparison with the board.
 */
const CHAT = '/projects/p_agentic/chats/cm1';

async function noHorizontalScroll(page: Page): Promise<void> {
    const [scrollWidth, innerWidth] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    expect(scrollWidth, 'the chat scrolls horizontally').toBeLessThanOrEqual(innerWidth);
}

test('Focus: header, steps boxes and the live line fit the width', async ({ page }, info) => {
    await page.goto(CHAT);
    await expect(page.locator('[data-chat-view-note]')).toContainText('one agent working · Focus picked automatically');
    await expect(page.locator('[data-chat-control="view"] button[aria-pressed="true"]')).toHaveText('Focus');
    await expect(page.locator('[data-chat-control="detail"] button[aria-pressed="true"]')).toHaveText('Steps');
    const summaries = page.locator('[data-scope="ai-steps"][data-part="summary"]');
    await expect(summaries).toHaveCount(2);
    await expect(summaries.nth(0)).toHaveAttribute('aria-expanded', 'false');
    await expect(summaries.nth(1)).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('[data-scope="ai-steps"][data-part="excerpt"]')).toBeVisible();
    await expect(page.locator('[data-scope="ai-live-line"][data-part="root"]')).toContainText('Forge');
    // Lanes needs 1024 px.
    const lanes = page.locator('[data-chat-control="view"] button', { hasText: 'Lanes' });
    await expect(lanes).toHaveCount((page.viewportSize()?.width ?? 0) < 1024 ? 0 : 1);
    await noHorizontalScroll(page);
    await page.screenshot({ path: info.outputPath(`chat-focus-${page.viewportSize()?.width}.png`) });

    // Raw: every call as its tool card, still within the width.
    await page.locator('[data-chat-control="detail"] button', { hasText: 'Raw' }).click();
    await expect(page.locator('[data-scope="ai-tool-call"][data-part="root"]').first()).toBeVisible();
    await expect(page.locator('[data-scope="ai-steps"][data-part="root"]')).toHaveCount(0);
    await noHorizontalScroll(page);
});

test('Team on the four-agent chat, and a pin that survives a reload', async ({ page }) => {
    await page.goto('/projects/p_agentic/chats/cm2');
    await expect(page.locator('[data-chat-view-note]')).toContainText('2 agents working · Team picked automatically');
    await expect(page.locator('[data-chat-control="detail"] button[aria-pressed="true"]')).toHaveText('Messages');
    await noHorizontalScroll(page);
    await page.locator('[data-chat-control="view"] button', { hasText: 'Focus' }).click();
    await expect(page.locator('[data-chat-view-note]')).toContainText('pinned by you');
    await page.reload();
    await expect(page.locator('[data-chat-control="view"] button[aria-pressed="true"]')).toHaveText('Focus');
    await noHorizontalScroll(page);
});

test('a pinned Lanes survives a reload and hydrates cleanly; Team again holds one thread (#1113)', async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) < 1024, 'Lanes needs 1024 px');
    const hydrate: string[] = [];
    page.on('console', (m) => { if (m.text().includes('[Hydrate]')) hydrate.push(m.text()); });
    await page.goto('/projects/p_agentic/chats/cm2');
    await page.locator('[data-chat-control="view"] button', { hasText: 'Lanes' }).click();
    await expect(page.locator('[data-chat-lanes]')).toBeVisible();
    await page.reload();
    await expect(page.locator('[data-chat-control="view"] button[aria-pressed="true"]')).toHaveText('Lanes');
    await expect(page.locator('[data-chat-lanes]')).toBeVisible();
    await page.locator('[data-chat-control="view"] button', { hasText: 'Team' }).click();
    await expect(page.locator('[data-chat-lanes]')).toHaveCount(0);
    await expect(page.locator('[data-chat-main] [data-scope="ai-thread"][data-part="root"]')).toHaveCount(1);
    expect(hydrate).toEqual([]);
});
