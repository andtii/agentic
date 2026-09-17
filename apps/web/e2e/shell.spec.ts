import { test, expect, type Page } from '@playwright/test';

const shell = (part: string) => `[data-scope="ai-shell"][data-part="${part}"]`;
const drawerPanel = '[data-scope="drawer"][data-part="panel"]';

async function expectPage(page: Page, path: string, title: string) {
    await expect(page).toHaveURL(new RegExp(`${path.replace(/\//g, '\\/')}$`));
    await expect(page.locator('[data-page-title]')).toHaveText(title);
}

test('renders the control-room shell, restores the theme before paint, and navigates two routes', async ({ page }, info) => {
    const narrow = info.project.name === 'phone-400';

    await page.goto('/');
    await expect(page.locator(shell('root'))).toBeVisible();
    await expect(page.locator(shell('bar'))).toBeVisible();
    await expect(page.locator(shell('main'))).toBeVisible();
    await expectPage(page, '/', 'Home');

    // themeInitScript and the font links are in <head>, ahead of the app; the one theme is set on <html>.
    const head = await page.locator('head').innerHTML();
    expect(head).toContain('zero-theme');
    expect(head).toContain('fonts.googleapis.com/css2?family=Schibsted+Grotesk');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'control-room');
    // The design system's tokens resolve on the page.
    const sidebarWidth = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ag-sidebar-w').trim());
    expect(sidebarWidth).toBe('232px');

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
        // At 1280px: the 232 px sidebar is the nav under a 60 px topbar; the Drawer trigger is gone.
        const sidebar = page.locator(shell('sidebar'));
        await expect(sidebar).toBeVisible();
        await expect(page.locator(shell('menu'))).toBeHidden();
        expect((await sidebar.boundingBox())?.width).toBe(232);
        expect((await page.locator(shell('bar')).boundingBox())?.height).toBe(60);

        // Two nav groups; the Home badge counts what needs a person.
        await expect(sidebar.getByRole('navigation', { name: 'Primary' })).toBeVisible();
        await expect(sidebar.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
        await expect(sidebar.locator(shell('badge'))).toHaveText(/^[1-9]\d*$/);
        await expect(sidebar.locator(shell('connection'))).toBeVisible();

        await sidebar.getByRole('link', { name: 'Agents' }).click();
        await expectPage(page, '/agents', 'Agents');
        await expect(sidebar.locator('[data-part="nav-item"][data-state="active"]')).toHaveText('Agents');
        await expect(page.locator(shell('breadcrumb'))).toContainText('Agents');

        await sidebar.getByRole('link', { name: 'Machines' }).click();
        await expectPage(page, '/machines', 'Machines');
    }

    // A parameterised route renders its entity from the mock data.
    await page.goto('/agents/a1');
    await expectPage(page, '/agents/a1', 'Scout');
});

test('the nav entries for chats, tasks, history and usage resolve', async ({ page }) => {
    for (const [path, title] of [['/chats', 'Chats'], ['/tasks', 'Tasks'], ['/history', 'History'], ['/usage', 'Usage']] as const) {
        await page.goto(path);
        await expectPage(page, path, title);
    }
});
