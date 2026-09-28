import { test, expect, type Page } from '@playwright/test';

/**
 * The chat's Team view (#1059; `docs/design/chat-modes/screenshots/ChatTeam.png`) at every width: the crew
 * strip (sideways on the phone), the handoff lines, Lint's done card, Scout's question, Forge's live card and
 * the coordinator hint — and no horizontal page scroll. The screenshots land in the test output for a by-eye
 * comparison with the board.
 */
const CHAT = '/projects/p_agentic/chats/cm2';

async function noHorizontalScroll(page: Page): Promise<void> {
    const [scrollWidth, innerWidth] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    expect(scrollWidth, 'the chat scrolls horizontally').toBeLessThanOrEqual(innerWidth);
}

test('Team: crew strip, handoffs, work cards and the question fit the width', async ({ page }, info) => {
    await page.goto(CHAT);
    await expect(page.locator('[data-chat-view-note]')).toContainText('2 agents working · Team picked automatically');
    await expect(page.locator('[data-chat-control="view"] button[aria-pressed="true"]')).toHaveText('Team');
    await expect(page.locator('[data-chat-control="detail"] button[aria-pressed="true"]')).toHaveText('Messages');
    await expect(page.locator('[data-scope="ai-crew"][data-part="chip"]')).toHaveCount(4);
    await expect(page.locator('[data-scope="ai-handoff"][data-part="root"]')).toHaveCount(3);
    await expect(page.locator('[data-chat-team-agent="lint"] [data-scope="ai-work-card"][data-part="result"]')).toBeVisible();
    await expect(page.locator('[data-chat-team-question] [data-chat-team-blocks]')).toHaveText('blocks #23');
    await expect(page.locator('[data-chat-team-agent="forge"] [data-scope="ai-work-card"][data-part="root"]')).toHaveAttribute('data-state', 'running');
    await expect(page.locator('[data-scope="ai-composer"][data-part="hint"]')).toHaveText('Atlas answers unless you @ someone');
    await noHorizontalScroll(page);
    await page.screenshot({ path: info.outputPath(`chat-team-${page.viewportSize()?.width}.png`) });

    // A chip follows its agent; the page still fits.
    await page.locator('[data-scope="ai-crew"][data-part="chip"]').nth(1).click();
    await expect(page.locator('[data-scope="ai-crew"][data-part="chip"]').nth(1)).toHaveAttribute('aria-pressed', 'true');
    await noHorizontalScroll(page);
});

test('on the phone the crew strip scrolls sideways inside itself', async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) >= 768, 'the phone regime only');
    await page.goto(CHAT);
    const strip = page.locator('[data-scope="ai-crew"][data-part="root"]');
    await expect(strip).toBeVisible();
    const [scrollWidth, clientWidth] = await strip.evaluate((el) => [el.scrollWidth, el.clientWidth]);
    expect(scrollWidth).toBeGreaterThan(clientWidth);
    await noHorizontalScroll(page);
});
