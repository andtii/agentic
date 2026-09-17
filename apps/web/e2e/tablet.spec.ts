import { test, expect, type Page } from '@playwright/test';

/**
 * 768–1279 (#91, `docs/design/HANDOFF.md` → "Responsive behaviour"): the
 * sidebar stays, the fixed right rails drop under the main column — Home,
 * Task, Session, Machine, Memory — Chat keeps list + thread with the
 * context panel behind the topbar's tasks button, and three-column card
 * grids become two. Project `tablet-1024` only.
 */
const shell = (part: string) => `[data-scope="ai-shell"][data-part="${part}"]`;

/** `rail` sits below `main` in the same column: its top is past main's bottom and its left edge lines up. */
async function expectRailBelow(page: Page, main: string, rail: string) {
    const [m, r] = await Promise.all([page.locator(main).boundingBox(), page.locator(rail).boundingBox()]);
    expect(m, main).not.toBeNull();
    expect(r, rail).not.toBeNull();
    expect(r!.y, `${rail} below ${main}`).toBeGreaterThanOrEqual(m!.y + m!.height - 1);
    expect(Math.round(r!.x), `${rail} in the same column as ${main}`).toBe(Math.round(m!.x));
}

test.describe('tablet', () => {
    test.skip(({ viewport }) => {
        const w = viewport?.width ?? 0;
        return w < 768 || w >= 1280;
    }, 'the 768–1279 regime');

    test('keeps the sidebar and drops the rails under the main column in the handoff order', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator(shell('sidebar'))).toBeVisible();
        expect((await page.locator(shell('sidebar')).boundingBox())?.width).toBe(232);
        await expectRailBelow(page, '[data-home-needs]', '[data-home-rail]');

        await page.goto('/tasks/t1-1');
        await expectRailBelow(page, '[data-task-tree]', '[data-task-rail]');

        await page.goto('/sessions/s1');
        await expectRailBelow(page, '[data-session-main]', '[data-session-rail]');

        await page.goto('/machines/alien01');
        await expectRailBelow(page, '[data-machine-sessions]', '[data-machine-rail]');

        await page.goto('/agents/a1?tab=memory');
        const memory = page.locator('[data-agent-memory]');
        await expect(memory).toBeVisible();
        expect(await memory.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(1);
    });

    test('chat keeps list + thread; the context panel opens from the topbar tasks button', async ({ page }) => {
        await page.goto('/chats/c1');
        await expect(page.locator('[data-page="chat"] > [data-chat-list]')).toBeVisible();
        await expect(page.locator('[data-scope="ai-thread"][data-part="root"]')).toBeVisible();
        await expect(page.locator('[data-page="chat"] > [data-chat-context]')).toBeHidden();
        const tasks = page.locator(shell('actions')).getByRole('button', { name: 'Tasks in this chat' });
        await expect(tasks).toBeVisible();
        await tasks.click();
        const drawer = page.locator('[data-scope="drawer"][data-part="panel"]').filter({ has: page.locator('[data-context-drawer]') });
        await expect(drawer).toBeVisible();
        await expect(drawer.getByRole('navigation', { name: 'Members' }).or(drawer.getByText('Members').first())).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(drawer).toBeHidden();
    });

    test('three-column card grids become two, and nothing scrolls horizontally', async ({ page }) => {
        await page.goto('/machines');
        expect(await page.locator('[data-env-grid]').first().evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(2);
        await page.goto('/plugins');
        expect(await page.locator('[data-plugin-grid]').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(2);
        for (const path of ['/', '/chats/c1', '/tasks/t1-1', '/sessions/s1', '/agents', '/agents/a1', '/machines', '/machines/alien01', '/pair', '/schedules', '/plugins', '/settings', '/history', '/usage']) {
            await page.goto(path);
            const [scrollWidth, innerWidth] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
            expect(scrollWidth, path).toBeLessThanOrEqual(innerWidth);
        }
    });
});
