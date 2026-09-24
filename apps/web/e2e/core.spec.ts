import { test, expect, type Page } from '@playwright/test';

/**
 * The core flow on mock data (#88): Home → chat → task → session through
 * links, the sidebar badge agreeing with what needs a person, no console
 * errors along the way. Desktop only: the mobile pass (#91) owns 400 px.
 */
const shell = (part: string) => `[data-scope="ai-shell"][data-part="${part}"]`;

function watchConsole(page: Page): string[] {
    const errors: string[] = [];
    page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(String(e)));
    return errors;
}

test.describe('core flow', () => {
    test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, 'desktop only; mobile.spec and tablet.spec cover the other regimes');

    test('navigates Home → chat → task → session through links, with the badge counting what needs you', async ({ page }) => {
        const errors = watchConsole(page);

        await page.goto('/');
        await expect(page.locator('[data-page="home"]')).toBeVisible();
        const needs = page.locator('[data-scope="ag-needs-item"][data-part="root"]');
        const open = await needs.count();
        expect(open).toBeGreaterThan(0);
        await expect(page.locator('[data-scope="drawer"][data-part="panel"][data-l-dock-above] [data-scope="nav-list"] [data-scope="badge"]')).toHaveText(String(open));
        // Approvals first, then input, then interrupted.
        await expect(needs.first()).toHaveAttribute('data-kind', 'approval');
        await expect(page.locator('[data-home-tasks] colgroup col').first()).toHaveAttribute('style', /--table-column-width: ?100px/);

        // The approval item's "Open chat" leads to the chat.
        await needs.first().getByRole('link', { name: 'Open chat' }).click();
        await expect(page).toHaveURL(/\/chats\/c1$/);
        await expect(page.locator('[data-page="chat"]')).toBeVisible();
        await expect(page.locator(shell('breadcrumb'))).toContainText('Mobile pass #47');
        await expect(page.locator('[data-scope="ai-thread"][data-part="root"]')).toBeVisible();
        await expect(page.locator('[data-scope="ai-composer"][data-part="addressing"]')).toContainText('Atlas answers unless you @ someone');
        // The context panel's mini-tree links to each task in the chain.
        await page.locator('[data-chat-context]').getByRole('link', { name: 'Make the drawer collapse below 768 px in shell.css' }).click();
        await expect(page).toHaveURL(/\/tasks\/t1-1$/);
        await expect(page.locator('[data-page="task"]')).toBeVisible();
        await expect(page.locator(shell('breadcrumb'))).toContainText('Tasks');
        await expect(page.locator('[data-scope="ag-task-node"][data-part="root"]')).toHaveCount(3);

        // The route's node is selected: its approval sits under the tree, its contract in the rail; its session opens from the topbar.
        await expect(page.locator('[data-scope="ag-task-node"][data-part="root"][data-mod-selected]')).toHaveCount(1);
        await expect(page.locator('[data-task-tree] [data-scope="ai-approval"][data-part="root"]')).toBeVisible();
        await expect(page.locator('[data-task-rail] [data-ref]')).toHaveText('t_8f2c');
        // Selecting the Lint node swaps the rail and takes the approval with it.
        await page.locator('[data-scope="ag-task-node"][data-part="card"]').nth(2).click();
        await expect(page.locator('[data-task-rail] [data-ref]')).toHaveText('t_8f2d');
        await expect(page.locator('[data-task-tree] [data-scope="ai-approval"][data-part="root"]')).toHaveCount(0);
        await page.locator(shell('bar')).getByRole('link', { name: 'Open session' }).click();
        await expect(page).toHaveURL(/\/sessions\/s1$/);
        await expect(page.locator('[data-page="session"]')).toBeVisible();
        await expect(page.locator('[data-session-id]')).toHaveText('Session s_41aa');
        await expect(page.locator('[data-capability][data-supported="false"]')).toHaveCount(2);
        await expect(page.locator('[data-event][data-kind="request"]')).toBeVisible();

        // The tasks list is the breadcrumb's parent.
        await page.goto('/tasks');
        await expect(page.locator('[data-page="tasks"]')).toBeVisible();
        await expect(page.locator('[data-filter-chips] [aria-pressed="true"]')).toContainText('All');

        expect(errors, errors.join('\n')).toEqual([]);
    });

    test('no route scrolls horizontally at 1280', async ({ page }) => {
        for (const path of ['/', '/chats', '/chats/c1', '/tasks', '/tasks/t1-1', '/sessions/s1', '/sessions/s3']) {
            await page.goto(path);
            const [scrollWidth, innerWidth] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
            expect(scrollWidth, path).toBeLessThanOrEqual(innerWidth);
        }
    });
});
