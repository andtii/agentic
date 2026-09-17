import { test, expect, type Page } from '@playwright/test';

const shell = (part: string) => `[data-scope="ai-shell"][data-part="${part}"]`;
const drawerPanel = '[data-scope="drawer"][data-part="panel"]';

async function expectPage(page: Page, path: string, title: string) {
    await expect(page).toHaveURL(new RegExp(`${path.replace(/\//g, '\\/')}$`));
    await expect(page.locator('[data-page-title]')).toHaveText(title);
}

test('renders the shell, restores the theme before paint, and navigates two routes', async ({ page }, info) => {
    const narrow = info.project.name === 'phone-400';

    await page.goto('/');
    await expect(page.locator(shell('root'))).toBeVisible();
    await expect(page.locator(shell('bar'))).toBeVisible();
    await expect(page.locator(shell('main'))).toBeVisible();
    await expectPage(page, '/', 'Inbox');

    // themeInitScript is in <head>, ahead of the app.
    const head = await page.locator('head').innerHTML();
    expect(head).toContain('zero-theme');

    if (narrow) {
        // Below 768px: no sidebar, the Drawer carries the nav.
        await expect(page.locator(shell('sidebar'))).toBeHidden();
        await expect(page.locator(shell('menu'))).toBeVisible();

        await page.getByRole('button', { name: 'Menu' }).click();
        await expect(page.locator(drawerPanel)).toBeVisible();
        await page.locator(drawerPanel).getByRole('link', { name: 'Agents' }).click();
        await expectPage(page, '/agents', 'Agents');
        // Navigating closes the drawer.
        await expect(page.locator(drawerPanel)).toBeHidden();

        await page.getByRole('button', { name: 'Menu' }).click();
        await page.locator(drawerPanel).getByRole('link', { name: 'Machines' }).click();
        await expectPage(page, '/machines', 'Machines');
    } else {
        // At 1280px: the sidebar is the nav, the Drawer trigger is gone.
        await expect(page.locator(shell('sidebar'))).toBeVisible();
        await expect(page.locator(shell('menu'))).toBeHidden();

        const sidebar = page.locator(shell('sidebar'));
        await sidebar.getByRole('link', { name: 'Agents' }).click();
        await expectPage(page, '/agents', 'Agents');
        await expect(sidebar.locator('[data-part="nav-item"][data-state="active"]')).toHaveText('Agents');

        await sidebar.getByRole('link', { name: 'Machines' }).click();
        await expectPage(page, '/machines', 'Machines');
    }

    // A parameterised route renders its entity from the mock data.
    await page.goto('/agents/a1');
    await expectPage(page, '/agents/a1', 'Scout');
});

test('the theme toggle flips data-theme and survives a reload', async ({ page }) => {
    await page.goto('/settings');
    await expectPage(page, '/settings', 'Settings');
    const before = await page.locator('html').getAttribute('data-theme');
    await page.getByRole('button', { name: 'Theme' }).click();
    const after = await page.locator('html').getAttribute('data-theme');
    expect(after).not.toBe(before);
    expect(after).toBeTruthy();
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', after!);
});
