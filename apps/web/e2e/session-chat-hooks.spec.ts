import { test, expect } from '@playwright/test';

/**
 * A session's Changes and Files views reach its chat (#565), in the real
 * browser with Monaco: the Edit card's "View diff" opens the file's diff,
 * the header says who edited it, a question about a line lands in the chat
 * with its hunk, and "Mention in chat" puts `@file:` in the composer. The
 * mock workspace keeps what was posted for the visit, so the steps navigate
 * in the app rather than reload.
 */
test.describe('session chat hooks', () => {
    test('View diff, Edited by, ask about a line, mention a file', async ({ page }) => {
        test.skip(page.viewportSize()!.width < 1280, 'desktop layout');
        // Monaco loads and lays out twice (the diff, then the file): more than the default 30 s on a loaded runner (#817).
        test.setTimeout(90_000);
        await page.goto('/chats/c1');
        const link = page.locator('[data-scope="ai-tool-call"][data-part="link"]');
        await expect(link).toHaveText('View diff');
        await link.click();
        await expect(page.locator('[data-scope="ag-changes"][data-part="item"][aria-current] [data-part="name"]')).toHaveText('shell.css');
        await expect(page.locator('[data-file-edited]')).toContainText(/Edit at \d\d:\d\d/);

        // Monaco replaces the plain grid once it has loaded, then renders its lines: wait for both before
        // clicking one — on a loaded runner the click raced the render and timed out (#817).
        const surface = page.locator('[data-scope="ag-code"][data-engine="monaco"]');
        await expect(surface).toHaveAttribute('data-ready', '', { timeout: 20_000 });
        const line = surface.locator('.monaco-editor .line-numbers').nth(20);
        await expect(line).toBeVisible({ timeout: 20_000 });
        await line.click();
        const box = page.locator('[data-scope="ag-line-composer"] textarea');
        await expect(box).toBeVisible();
        // The composer sits in a Monaco view zone that can be laid out again (and remounted, dropping the text)
        // while the editor settles, and the button may sit below the editor's own scroll: send from the keyboard,
        // and type again if a remount ate the question before it went out (#817).
        const sent = page.locator('[data-files-sent]');
        await expect(async () => {
            if (!(await sent.isVisible())) {
                await box.fill('Does the drawer keep its focus trap once this collapses?');
                await box.press('Control+Enter');
            }
            await expect(sent).toBeVisible({ timeout: 3_000 });
        }).toPass({ timeout: 20_000 });

        await page.getByRole('link', { name: 'Open chat' }).click();
        await expect(page).toHaveURL(/\/chats\/c1$/);
        const mine = page.locator('[data-scope="ai-message"][data-part="root"]').filter({ hasText: 'Does the drawer keep its focus trap' });
        await expect(mine).toHaveCount(1);
        await expect(mine).toContainText('packages/ui/src/shell/shell.css:');
        await expect(mine.locator('pre')).toContainText('@@ ');

        await page.goto('/sessions/s1/files?path=packages%2Fui%2Fsrc%2Fshell%2Fshell.css');
        await page.getByRole('button', { name: 'Mention in chat' }).click();
        await expect(page).toHaveURL(/\/chats\/c1$/);
        await expect(page.locator('[data-chat-composer] textarea')).toHaveValue('@file:packages/ui/src/shell/shell.css ');
    });
});
