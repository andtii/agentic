import { test, expect, type Page } from '@playwright/test';

const shell = (part: string) => `[data-scope="ai-shell"][data-part="${part}"]`;
const drawerPanel = '[data-scope="drawer"][data-part="panel"]';
/** The shell's one navigation drawer: docked as the sidebar from md up, the modal sheet below. */
const sidebar = `${drawerPanel}[data-l-dock-above="md"]`;
const menu = `${shell('bar')} [data-scope="drawer"][data-part="trigger"]`;
const navLink = '[data-scope="nav-list"][data-part="link"]';

/** One banner and one navigation landmark in the DOM at every width (the breadcrumb is the page's, not the shell's nav). */
async function expectOneNav(page: Page) {
    await expect(page.getByRole('banner')).toHaveCount(1);
    await expect(page.locator('nav:not([aria-label="Breadcrumb"])')).toHaveCount(1);
    await expect(page.locator(`${sidebar} nav[data-scope="nav-list"][aria-label="Main"]`)).toHaveCount(1);
}

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
    await expectOneNav(page);

    // themeInitScript and the font links are in <head>, ahead of the app; the one theme is set on <html>.
    const head = await page.locator('head').innerHTML();
    expect(head).toContain('zero-theme');
    expect(head).toContain('fonts.googleapis.com/css2?family=Schibsted+Grotesk');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'control-room');
    // The design system's tokens resolve on the page.
    const sidebarWidth = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ag-sidebar-w').trim());
    expect(sidebarWidth).toBe('232px');

    if (narrow) {
        // Below 768px: the drawer is a closed modal sheet behind the menu button.
        await expect(page.locator(sidebar)).toBeHidden();
        await expect(page.locator(sidebar)).toHaveAttribute('data-l-dock', 'sheet');
        await expect(page.locator(menu)).toBeVisible();

        await page.getByRole('button', { name: 'Menu' }).click();
        await expect(page.locator(sidebar)).toBeVisible();
        await expect(page.locator(sidebar)).toHaveJSProperty('open', true);
        expect(await page.locator(sidebar).evaluate((el) => el.matches(':modal'))).toBe(true);
        await page.locator(sidebar).getByRole('link', { name: 'Agents' }).click();
        await expectPage(page, '/agents', 'Agents');
        // Navigating closes the drawer.
        await expect(page.locator(sidebar)).toBeHidden();

        await page.getByRole('button', { name: 'Menu' }).click();
        await page.locator(sidebar).getByRole('link', { name: 'Machines' }).click();
        await expectPage(page, '/machines', 'Machines');
        await expectOneNav(page);
    } else {
        // At 1280px: the drawer is docked as the 232 px sidebar under a 60 px topbar; its trigger and close are gone.
        const side = page.locator(sidebar);
        await expect(side).toBeVisible();
        await expect(side).toHaveAttribute('data-l-dock', 'inline');
        expect(await side.evaluate((el) => el.matches(':modal'))).toBe(false);
        await expect(page.locator(menu)).toBeHidden();
        await expect(side.locator('[data-scope="drawer"][data-part="close"]')).toBeHidden();
        expect((await side.boundingBox())?.width).toBe(232);
        expect((await page.locator(shell('bar')).boundingBox())?.height).toBe(60);

        // One nav, two groups; the Home badge counts what needs a person.
        const nav = side.getByRole('navigation', { name: 'Main' });
        await expect(nav).toBeVisible();
        await expect(nav.getByRole('group', { name: 'Primary' })).toBeVisible();
        await expect(nav.getByRole('group', { name: 'Workspace' })).toBeVisible();
        const badge = side.locator('[data-scope="badge"][data-part="root"]');
        await expect(badge).toHaveText(/^[1-9]\d*$/);
        await expect(badge).toHaveAttribute('aria-label', /^\d+ items? needs? you$/);
        await expect(side.locator(shell('connection'))).toBeVisible();

        await side.getByRole('link', { name: 'Agents' }).click();
        await expectPage(page, '/agents', 'Agents');
        await expect(side.locator(`${navLink}[aria-current="page"]`)).toHaveText('Agents');
        await expect(page.locator(shell('breadcrumb'))).toContainText('Agents');

        await side.getByRole('link', { name: 'Machines' }).click();
        await expectPage(page, '/machines', 'Machines');
    }

    // A parameterised route renders its entity from the mock data.
    await page.goto('/agents/a1');
    await expectPage(page, '/agents/a1', 'Scout');
});

test('the one drawer follows the viewport: a sheet opened narrow closes when the window widens, and docks', async ({ page }) => {
    test.skip(test.info().project.name !== 'desktop-1280', 'resizes the window itself; one project is enough');
    await page.setViewportSize({ width: 400, height: 800 });
    await page.goto('/');
    const side = page.locator(sidebar);
    await page.getByRole('button', { name: 'Menu' }).click();
    await expect(side).toBeVisible();
    expect(await side.evaluate((el) => el.matches(':modal'))).toBe(true);

    await page.setViewportSize({ width: 1024, height: 800 });
    await expect(side).toHaveAttribute('data-l-dock', 'inline');
    expect(await side.evaluate((el) => el.matches(':modal'))).toBe(false);
    await expect(side).toBeVisible();
    await expect(page.locator(menu)).toBeHidden();
    await expectOneNav(page);

    // Narrow again: the sheet the widening took down stays closed.
    await page.setViewportSize({ width: 400, height: 800 });
    await expect(side).toHaveAttribute('data-l-dock', 'sheet');
    await expect(side).toBeHidden();
    await expect(page.locator(menu)).toBeVisible();
});

test('the nav entries for chats, tasks, history and usage resolve', async ({ page }) => {
    for (const [path, title] of [['/chats', 'Chats'], ['/tasks', 'Tasks'], ['/history', 'History'], ['/usage', 'Usage']] as const) {
        await page.goto(path);
        await expectPage(page, path, title);
    }
});
