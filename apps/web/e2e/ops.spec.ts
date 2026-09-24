import { test, expect, type Page } from '@playwright/test';

/**
 * The operations routes (#90) at 1280: every page renders its `data-page`
 * carrier with no console error, the tables keep the handoff's column
 * templates, and nothing scrolls sideways.
 */
const ROUTES: { path: string; page: string; table?: { selector: string; cols: string[] } }[] = [
    { path: '/machines', page: 'machines' },
    { path: '/machines/alien01', page: 'machine', table: { selector: '.ag-sessions', cols: ['96px', 'auto', '120px', '104px', '56px', '76px', '100px'] } },
    { path: '/pair', page: 'pair' },
    { path: '/schedules', page: 'schedules', table: { selector: '.ag-schedules', cols: ['110px', 'auto', '140px', '140px', '310px', '44px'] } },
    { path: '/plugins', page: 'plugins' },
    { path: '/settings', page: 'settings' },
    { path: '/history', page: 'history', table: { selector: '.ag-history', cols: ['84px', '150px', '130px', 'auto', '110px'] } },
    { path: '/usage', page: 'usage', table: { selector: '.ag-usage', cols: ['auto', '120px', '120px', '130px', '150px'] } }
];

async function colWidths(page: Page, selector: string): Promise<string[]> {
    return page.locator(`${selector} colgroup > col`).evaluateAll((cols) => cols.map((c) => (c as HTMLElement).style.getPropertyValue('--table-column-width') || 'auto'));
}

for (const route of ROUTES) {
    test(`${route.path} renders without errors`, async ({ page }, info) => {
        test.skip(info.project.name !== 'desktop-1280', 'the mobile pass (#91) covers 400 px');
        const errors: string[] = [];
        page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
        page.on('pageerror', (e) => errors.push(String(e)));

        await page.goto(route.path);
        await expect(page.locator(`[data-page="${route.page}"]`)).toBeVisible();
        await expect(page.locator('[data-page-title]')).toHaveCount(1);
        if (route.table) expect(await colWidths(page, route.table.selector)).toEqual(route.table.cols);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        expect(errors).toEqual([]);
    });
}

test('Machines links to a machine and to Pair, and the Pair code counts down', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop-1280', 'the mobile pass (#91) covers 400 px');
    await page.goto('/machines');
    await page.getByRole('link', { name: 'Details' }).first().click();
    await expect(page).toHaveURL(/\/machines\/alien01$/);
    await expect(page.locator('[data-page="machine"] [data-machine-name]')).toHaveText('alien01');
    await page.goto('/machines');
    await page.getByRole('link', { name: 'Pair a machine' }).click();
    await expect(page).toHaveURL(/\/pair$/);
    await expect(page.locator('[data-code-cell]')).toHaveCount(6);
    const before = await page.locator('[data-code-status]').textContent();
    await page.waitForTimeout(1500);
    expect(await page.locator('[data-code-status]').textContent()).not.toBe(before);
});

test('Plugins asks before disabling a plugin with dependents', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop-1280', 'the mobile pass (#91) covers 400 px');
    await page.goto('/plugins');
    // The input is visually hidden under its control; a person clicks the switch itself.
    const claude = page.getByRole('switch', { name: 'Enable Claude Code' });
    await page.locator('[data-scope="switch"][data-part="root"]', { has: claude }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Disable Claude Code?');
    await expect(dialog).toContainText('Forge');
    await expect(dialog.getByRole('button', { name: 'Disable Claude Code' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Keep enabled' }).click();
    await expect(dialog).toBeHidden();
    await expect(claude).toBeChecked();
    // The switch never followed the row's link; the row itself opens the plugin's page (#637).
    await expect(page).toHaveURL(/\/plugins$/);
    await page.locator('[data-plugin-rows] [data-plugin-row][data-plugin="claude-code"] [data-plugin-row-part="name"]').click();
    await expect(page).toHaveURL(/\/plugins\/claude-code$/);
});

test('Plugins filters by category and search, and the URL keeps them', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop-1280', 'the mobile pass (#91) covers 400 px');
    await page.goto('/plugins?kind=memory&q=flat');
    await expect(page.locator('[data-plugin-rows] [data-plugin-row]')).toHaveCount(1);
    await expect(page.locator('[data-plugin-rows] [data-plugin-row]')).toHaveAttribute('data-plugin', 'agentic.memory.flat');
    await page.reload();
    await expect(page.locator('[data-plugin-rows] [data-plugin-row]')).toHaveCount(1);
    await expect(page.getByRole('searchbox', { name: 'Search plugins' })).toHaveValue('flat');
    // `/` focuses the search; clearing it widens the list and the URL follows.
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('/');
    await expect(page.getByRole('searchbox', { name: 'Search plugins' })).toBeFocused();
    await page.getByRole('searchbox', { name: 'Search plugins' }).fill('');
    await expect(page).toHaveURL(/\/plugins\?kind=memory$/);
    await expect(page.locator('[data-plugin-rows] [data-plugin-row]')).toHaveCount(2);
});
