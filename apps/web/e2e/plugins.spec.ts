import { test, expect } from '@playwright/test';

/**
 * The plugins redesign end to end (#641; boards `Plugins`, `PluginsConnectors`, `AddConnector`, `PluginDetail`) at
 * 1280, on mock data: a category from the URL, `/` focusing search, the add-connector flow (preview → Connect →
 * choose agents), a tool set to deny, and the disable confirm from a row. The 400 px and 768–1279 px layouts are
 * `mobile.spec.ts` and `tablet.spec.ts`.
 */
test.describe('plugins', () => {
    test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, 'as drawn, at 1280');

    test('a category from the URL selects its menu item and lists only that kind', async ({ page }) => {
        await page.goto('/plugins?kind=harness');
        const menu = page.getByRole('navigation', { name: 'Plugin categories' });
        await expect(menu.locator('a[aria-current="page"]')).toHaveAttribute('data-category', 'harness');
        await expect(page.locator('[data-plugin-group]')).toHaveCount(1);
        await expect(page.locator('[data-plugin-group]')).toHaveAttribute('data-plugin-group', 'runtime:harness');
        await expect(page.locator('[data-plugin-rows] [data-plugin-row][data-plugin="claude-code"]')).toBeVisible();
        // Another item is a link that keeps the URL the state.
        await menu.locator('a[data-category="memory"]').click();
        await expect(page).toHaveURL(/\/plugins\?kind=memory$/);
        await expect(page.locator('[data-plugin-group]')).toHaveAttribute('data-plugin-group', 'memory');
    });

    test('/ focuses the search from anywhere on the page, and typing filters into the URL', async ({ page }) => {
        await page.goto('/plugins');
        const search = page.getByRole('searchbox', { name: 'Search plugins' });
        await expect(search).not.toBeFocused();
        await page.locator('body').click({ position: { x: 5, y: 5 } });
        await page.keyboard.press('/');
        await expect(search).toBeFocused();
        await page.keyboard.type('googleapis');
        await expect(page).toHaveURL(/q=googleapis/);
        await expect(page.locator('[data-plugin-rows] [data-plugin-row][data-plugin="gmail"]')).toBeVisible();
    });

    test('add a connector: the preview, Connect (mock), then the agent step and the plugin page', async ({ page }) => {
        await page.goto('/plugins/connectors/add');
        await page.locator('[data-add-main] button[data-connector="gmail"]').click();
        await expect(page).toHaveURL(/selected=gmail/);
        const preview = page.locator('[data-add-preview][data-connector="gmail"]');
        await expect(preview.getByRole('heading', { name: 'Gmail' })).toBeVisible();
        await expect(preview.locator('[data-preview-group="tools"] [data-tool]').first()).toBeVisible();
        await expect(preview).toContainText('Next: sign in, then choose which agents get it.');

        await preview.getByRole('button', { name: 'Connect Gmail' }).click();
        await expect(page).toHaveURL(/next=agents/);
        const step = page.locator('[data-add-step="agents"]');
        await expect(step.getByRole('heading', { name: 'Choose agents for Gmail' })).toBeVisible();
        // None are picked for you (PLG-04): the add button waits for a choice.
        const boxes = step.locator('[data-add-agents] input[type="checkbox"]');
        expect(await boxes.count()).toBeGreaterThan(0);
        for (const box of await boxes.all()) await expect(box).not.toBeChecked();
        await expect(step.getByRole('button', { name: 'Add to agents' })).toBeDisabled();
        await boxes.first().check();
        await step.getByRole('button', { name: 'Add to 1 agent' }).click();
        await expect(page).toHaveURL(/\/plugins\/gmail$/);
    });

    test('a tool set to deny on the plugin page', async ({ page }) => {
        await page.goto('/plugins/gmail');
        const tool = page.locator('[data-tool-policy="gmail__send-email"]');
        await expect(tool).toBeVisible();
        const deny = tool.getByRole('button', { name: 'deny' });
        await expect(deny).toHaveAttribute('aria-pressed', 'false');
        await deny.click();
        await expect(deny).toHaveAttribute('aria-pressed', 'true');
        await expect(tool.getByRole('button', { name: 'ask' })).toHaveAttribute('aria-pressed', 'false');
    });

    test('disabling a plugin with dependents from its row asks first, and Keep enabled keeps it', async ({ page }) => {
        await page.goto('/plugins');
        const row = page.locator('[data-plugin-rows] [data-plugin-row][data-plugin="claude-code"]');
        const claude = row.getByRole('switch', { name: 'Enable Claude Code' });
        await row.locator('[data-scope="switch"][data-part="root"]').click();
        const dialog = page.getByRole('alertdialog');
        await expect(dialog).toContainText('Disable Claude Code?');
        await expect(dialog).toContainText('Forge');
        await dialog.getByRole('button', { name: 'Keep enabled' }).click();
        await expect(dialog).toBeHidden();
        await expect(claude).toBeChecked();
        // The switch never followed the row's link.
        await expect(page).toHaveURL(/\/plugins$/);
    });
});
