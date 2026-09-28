import { test, expect, type Page } from '@playwright/test';

/**
 * The chat's Lanes view (#1061; `docs/design/chat-modes/screenshots/ChatLanes.png`) at 1280 px: pinned on the
 * four-agent register chat, Atlas's latest word on top, then a lane each for Forge, Lint and Scout — Scout's
 * question on its footer — and no horizontal page scroll. Below 1024 px Lanes is not offered. The screenshot
 * lands in the test output for a by-eye comparison with the board.
 */
const CHAT = '/projects/p_agentic/chats/cm2';

async function noHorizontalScroll(page: Page): Promise<void> {
    const [scrollWidth, innerWidth] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    expect(scrollWidth, 'the chat scrolls horizontally').toBeLessThanOrEqual(innerWidth);
}

test('Lanes: the coordinator on top, a lane per agent at work, the question footer', async ({ page }, info) => {
    const width = page.viewportSize()?.width ?? 0;
    await page.goto(CHAT);
    const lanesButton = page.locator('[data-chat-control="view"] button', { hasText: 'Lanes' });
    test.skip(width < 1024, 'Lanes needs 1024 px');
    // A click before hydration does nothing: click until the pin shows.
    await expect(async () => {
        await lanesButton.click();
        await expect(page.locator('[data-chat-view-note]')).toContainText('pinned by you · one column per agent at work', { timeout: 1_000 });
    }).toPass();
    await expect(page.locator('[data-chat-control="detail"] button[aria-pressed="true"]')).toHaveText('Steps');
    await expect(page.locator('[data-chat-lanes-top]')).toContainText('Atlas');
    await expect(page.locator('[data-scope="ai-lane"][data-part="name"]')).toHaveText(['Forge', 'Lint', 'Scout']);
    await expect(page.locator('[data-chat-lane="lint"] [data-scope="ai-lane"][data-part="footer"]')).toHaveText('Done · #22 ticked');
    await expect(page.locator('[data-chat-lane="scout"] [data-scope="ai-lane"][data-part="question"]')).toContainText('Asks you');
    // Equal widths.
    const widths = await page.locator('[data-chat-lane]').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
    expect(new Set(widths).size).toBe(1);
    await noHorizontalScroll(page);
    await page.screenshot({ path: info.outputPath(`chat-lanes-${width}.png`) });
});

test('Lanes is not offered below 1024 px', async ({ page }) => {
    const width = page.viewportSize()?.width ?? 0;
    test.skip(width >= 1024, 'wide enough for Lanes');
    await page.goto(CHAT);
    await expect(page.locator('[data-chat-control="view"] button', { hasText: 'Team' })).toBeVisible();
    await expect(page.locator('[data-chat-control="view"] button', { hasText: 'Lanes' })).toHaveCount(0);
});
