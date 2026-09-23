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
        await page.goto('/chats/c1');
        const link = page.locator('[data-scope="ai-tool-call"][data-part="link"]');
        await expect(link).toHaveText('View diff');
        await link.click();
        await expect(page.locator('[data-scope="ag-changes"][data-part="item"][aria-current] [data-part="name"]')).toHaveText('shell.css');
        await expect(page.locator('[data-file-edited]')).toContainText(/Edit at \d\d:\d\d/);

        await page.locator('.monaco-editor .line-numbers').nth(20).click();
        const box = page.locator('[data-scope="ag-line-composer"] textarea');
        await expect(box).toBeVisible();
        await box.fill('Does the drawer keep its focus trap once this collapses?');
        await page.getByRole('button', { name: /Send to chat/ }).click();
        await expect(page.locator('[data-files-sent]')).toBeVisible();

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
