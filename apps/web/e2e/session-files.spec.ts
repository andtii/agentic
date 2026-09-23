import { test, expect, type Page } from '@playwright/test';

/**
 * A session's Changes and Files views (#564) at every width: the session
 * bar's tabs lead between them, Monaco takes over from the plain grid, a
 * line number opens the "ask" composer, and no route scrolls sideways. On a
 * phone the list and the file are two screens.
 */
const PATHS = ['/sessions/s1', '/sessions/s1/changes', '/sessions/s1/changes?view=split', '/sessions/s1/changes?scope=branch', '/sessions/s1/files', '/sessions/s1/files?path=packages%2Fui%2Fsrc%2Fshell%2Fshell.css', '/sessions/s3/changes', '/sessions/s4/changes'];

function watchConsole(page: Page): string[] {
    const errors: string[] = [];
    page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(String(e)));
    return errors;
}

const tab = (page: Page, name: RegExp) => page.locator('[data-scope="ag-session-bar"][data-part="tab"]').filter({ hasText: name });

test.describe('session Changes and Files', () => {
    test('no view scrolls horizontally', async ({ page }) => {
        for (const path of PATHS) {
            await page.goto(path);
            await expect(page.locator('[data-scope="ag-session-bar"][data-part="root"]')).toBeVisible();
            const [scrollWidth, innerWidth] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
            expect(scrollWidth, path).toBeLessThanOrEqual(innerWidth);
        }
    });

    test('desktop: tabs, the Monaco diff, asking about a line, and the file tree', async ({ page, viewport }) => {
        test.skip((viewport?.width ?? 0) < 768, 'the phone has its own screens');
        const errors = watchConsole(page);
        await page.goto('/sessions/s1');
        await expect(tab(page, /^Changes/)).toContainText('3');
        await tab(page, /^Changes/).click();
        await expect(page).toHaveURL(/\/sessions\/s1\/changes$/);
        await expect(page.locator('[data-scope="ag-changes"][data-part="item"]')).toHaveCount(3);
        // Monaco replaces the plain grid once it has loaded.
        const surface = page.locator('[data-scope="ag-code"][data-engine="monaco"]');
        await expect(surface).toHaveAttribute('data-ready', '', { timeout: 20_000 });
        await surface.locator('.line-numbers').filter({ hasText: /^40$/ }).first().click();
        const composer = page.locator('[data-scope="ag-line-composer"][data-part="root"]');
        await expect(composer).toHaveCount(1);
        await expect(composer).toContainText('Ask Forge about line 40');
        await composer.getByRole('button', { name: 'Cancel' }).click();
        await expect(composer).toHaveCount(0);

        await page.getByRole('button', { name: 'Split' }).click();
        await expect(page).toHaveURL(/view=split/);

        await tab(page, /^Files/).click();
        await expect(page).toHaveURL(/\/sessions\/s1\/files$/);
        await page.locator('[data-scope="ag-file-tree"][data-part="item"][data-path="packages"]').click();
        await page.locator('[data-scope="ag-file-tree"][data-part="item"][data-path="packages/ui"]').click();
        await page.locator('[data-scope="ag-file-tree"][data-part="item"][data-path="packages/ui/src"]').click();
        await page.locator('[data-scope="ag-file-tree"][data-part="item"][data-path="packages/ui/src/shell"]').click();
        await page.locator('[data-scope="ag-file-tree"][data-part="item"][data-path="packages/ui/src/shell/shell.css"]').click();
        await expect(page).toHaveURL(/path=packages%2Fui%2Fsrc%2Fshell%2Fshell\.css/);
        await expect(page.locator('[data-scope="ag-file-header"][data-part="facts"]')).toContainText('lines');
        await page.getByRole('link', { name: 'Open diff' }).click();
        await expect(page).toHaveURL(/\/changes\?file=packages%2Fui%2Fsrc%2Fshell%2Fshell\.css/);
        expect(errors, errors.join('\n')).toEqual([]);
    });

    test('phone: the list opens the diff full-screen, and back returns to it', async ({ page, viewport }) => {
        test.skip((viewport?.width ?? 0) >= 768, 'phone only');
        await page.goto('/sessions/s1/changes');
        const list = page.locator('[data-scope="ag-changes"][data-part="root"]');
        await expect(list).toBeVisible();
        await expect(page.locator('[data-files-main]')).toBeHidden();
        await page.locator('[data-scope="ag-changes"][data-part="item"]').nth(1).click();
        await expect(page).toHaveURL(/file=packages%2Fui%2Fsrc%2Fshell%2FDrawer\.tsx/);
        await expect(list).toBeHidden();
        await expect(page.locator('[data-files-main]')).toBeVisible();
        await expect(page.locator('[data-scope="ag-file-header"] [data-part="name"]')).toHaveText('Drawer.tsx');
        await page.locator('[data-files-back]').click();
        await expect(list).toBeVisible();
    });
});
