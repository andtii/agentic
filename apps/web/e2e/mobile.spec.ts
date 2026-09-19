import { test, expect, type Page } from '@playwright/test';

/**
 * The phone regime (#91, `docs/design/HANDOFF.md` → "Responsive behaviour",
 * "Mobile specifics"): every route fits 400 px with no horizontal scroll,
 * the drawer opens and closes with focus back on its trigger, the composer
 * docks with 48 px controls, and the approval card's `Allow once` takes the
 * full row. Project `phone-400` only.
 */
const shell = (part: string) => `[data-scope="ai-shell"][data-part="${part}"]`;
const drawerPanel = '[data-scope="drawer"][data-part="panel"]';

const ROUTES = ['/', '/chats/c1', '/tasks/t1-1', '/sessions/s1', '/agents', '/agents/a1', '/machines', '/machines/alien01', '/pair', '/schedules', '/plugins', '/settings', '/history', '/usage'];

async function noHorizontalScroll(page: Page, path: string) {
    const [scrollWidth, innerWidth] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    expect(scrollWidth, `${path} scrolls horizontally`).toBeLessThanOrEqual(innerWidth);
}

test.describe('phone', () => {
    test.skip(({ viewport }) => (viewport?.width ?? 0) >= 768, 'the phone regime');

    test('no route scrolls horizontally at 400, and the app bar is 60 px on base-200 with page padding 16', async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        for (const path of ROUTES) {
            await page.goto(path);
            await expect(page.locator(shell('bar'))).toBeVisible();
            await noHorizontalScroll(page, path);
            expect((await page.locator(shell('bar')).boundingBox())?.height, path).toBe(60);
        }
        expect(await page.locator(shell('main')).evaluate((el) => getComputedStyle(el).paddingLeft)).toBe('16px');
        expect(errors, errors.join('\n')).toEqual([]);
    });

    test('the drawer is 312 px with 50 px items and the connection strip at its foot, and closes with focus back on Menu', async ({ page }) => {
        await page.goto('/');
        // A root route shows the menu; the sidebar is gone; the title is the page.
        await expect(page.locator(shell('sidebar'))).toBeHidden();
        const menu = page.getByRole('button', { name: 'Menu' });
        expect((await menu.boundingBox())?.width).toBe(44);
        await expect(page.locator(shell('title-text'))).toHaveText('Home');

        await menu.click();
        const panel = page.locator(drawerPanel);
        await expect(panel).toBeVisible();
        await expect.poll(async () => Math.round((await panel.boundingBox())?.width ?? 0)).toBe(312);
        const item = panel.locator('[data-part="nav-item"]').first();
        expect((await item.boundingBox())?.height).toBe(50);
        expect(await item.locator('a').evaluate((a) => getComputedStyle(a).fontSize)).toBe('16px');
        expect(await item.locator('svg').evaluate((s) => s.getBoundingClientRect().width)).toBe(20);
        await expect(panel.locator(shell('connection'))).toBeVisible();

        const close = panel.getByRole('button', { name: 'Close' });
        expect(Math.round((await close.boundingBox())?.width ?? 0)).toBe(44);
        await close.click();
        await expect(panel).toBeHidden();
        await expect(menu).toBeFocused();

        // Escape closes it too, and a link inside navigates then closes.
        await menu.click();
        await expect(panel).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(panel).toBeHidden();
        await menu.click();
        await panel.getByRole('link', { name: 'Machines' }).click();
        await expect(page).toHaveURL(/\/machines$/);
        await expect(panel).toBeHidden();
    });

    test('a detail route gets a back link instead of the menu, and a title with the entity name and sub-line', async ({ page }) => {
        await page.goto('/agents/a1');
        await expect(page.locator(shell('title-text'))).toHaveText('Scout');
        await expect(page.locator(shell('subtitle'))).toContainText('Researcher');
        await expect(page.getByRole('button', { name: 'Menu' })).toBeHidden();
        const back = page.locator(shell('back')).getByRole('link', { name: 'Back' });
        expect((await back.boundingBox())?.width).toBe(44);
        await back.click();
        await expect(page).toHaveURL(/\/agents$/);
        await expect(page.locator(shell('title-text'))).toHaveText('Agents');
        // The Machines title names the machine.
        await page.goto('/machines/alien01');
        await expect(page.locator(shell('title-text'))).toHaveText('alien01');
    });

    test('chat: title with member tiles and the status summary, the tasks button opens the context panel, the composer docks with 48 px controls', async ({ page }) => {
        await page.goto('/chats/c1');
        await expect(page.locator(shell('title-text'))).toHaveText('Mobile pass #47');
        await expect(page.locator(shell('subtitle'))).toContainText('waiting');
        // The chat list is gone; the thread and the composer remain.
        await expect(page.locator('[data-page="chat"] > [data-chat-list]')).toBeHidden();
        await expect(page.locator('[data-scope="ai-thread"][data-part="root"]')).toBeVisible();
        const composer = page.locator('[data-scope="ai-composer"][data-part="root"]');
        await expect(composer).toBeVisible();
        const attach = composer.getByRole('button', { name: 'Attach file' });
        const send = composer.getByRole('button', { name: 'Send' });
        expect((await attach.boundingBox())?.height).toBe(48);
        expect((await send.boundingBox())?.height).toBe(48);
        expect((await send.boundingBox())?.width).toBe(48);
        const textarea = composer.locator('textarea');
        expect((await textarea.boundingBox())?.height).toBe(48);
        expect(await textarea.evaluate((el) => getComputedStyle(el).fontSize)).toBe('15px');
        // Docked: the composer's bottom edge is the viewport's.
        const box = (await composer.boundingBox())!;
        expect(Math.round(box.y + box.height)).toBe(page.viewportSize()!.height);
        // The environment line leaves the message meta but stays in the approval card.
        await expect(page.locator('[data-scope="ai-message"][data-part="environment"]').first()).toBeHidden();
        await expect(page.locator('[data-scope="ai-approval"][data-part="context"] [data-scope="ag-env-line"]').first()).toBeVisible();

        // The one right slot opens the members-and-tasks panel as an end drawer.
        await page.locator(shell('phone-action')).getByRole('button', { name: 'Tasks in this chat' }).click();
        const drawer = page.locator(drawerPanel).filter({ has: page.locator('[data-context-drawer]') });
        await expect(drawer).toBeVisible();
        await expect(drawer.getByRole('link', { name: 'Open tree' })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(drawer).toBeHidden();
    });

    test('the Home "Needs you" heading is one line with its count beside it, and the hint is dropped (#118)', async ({ page }) => {
        await page.goto('/');
        const heading = page.locator('[data-home-needs] > [data-section-heading] > h2');
        await expect(heading).toHaveText(/Needs you\s*\d+ open/);
        const [box, lineHeight] = await Promise.all([heading.boundingBox(), heading.evaluate((el) => parseFloat(getComputedStyle(el.firstElementChild!).lineHeight))]);
        // One line: the heading is no taller than its line box; the count sits on that same line.
        expect(box!.height).toBeLessThanOrEqual(Math.ceil(lineHeight) + 1);
        const count = await heading.locator('[data-section-count]').boundingBox();
        expect(Math.round(count!.y + count!.height)).toBeLessThanOrEqual(Math.round(box!.y + box!.height));
        expect(count!.x).toBeGreaterThan(box!.x);
        await expect(page.locator('[data-home-needs] > [data-section-heading] > [data-section-aside]')).toBeHidden();
    });

    test('the approval card gives Allow once a full row and the other two answers share the next, at 48 px', async ({ page }) => {
        await page.goto('/');
        const card = page.locator('[data-scope="ag-needs-item"][data-kind="approval"] [data-scope="ai-approval"][data-part="root"]').first();
        await expect(card).toBeVisible();
        const once = card.getByRole('button', { name: 'Allow once' });
        const session = card.getByRole('button', { name: 'Allow for this session' });
        // The phone shows the short label; the full one stays as the accessible name.
        await expect(session.locator('[data-part="label-short"]')).toBeVisible();
        await expect(session.locator('[data-part="label-full"]')).toBeHidden();
        const deny = card.getByRole('button', { name: 'Deny' });
        const [o, s, d, c] = await Promise.all([once.boundingBox(), session.boundingBox(), deny.boundingBox(), card.boundingBox()]);
        expect(o!.height).toBe(48);
        expect(s!.height).toBe(48);
        // Allow once spans the card's content width; the other two sit beside each other below it.
        expect(o!.width).toBeGreaterThan(c!.width * 0.8);
        expect(s!.y).toBeGreaterThan(o!.y + o!.height - 1);
        expect(Math.round(s!.y)).toBe(Math.round(d!.y));
        expect(d!.x).toBeGreaterThan(s!.x + s!.width - 1);
    });

    test('tables become stacked cards captioned by their column heads, and machines fold to 52 px environment rows', async ({ page }) => {
        await page.goto('/schedules');
        const row = page.locator('[data-ag-table] [data-scope="table"][data-part="body"] > [data-scope="table"][data-part="row"]').first();
        expect(await row.evaluate((el) => getComputedStyle(el).display)).toBe('flex');
        const cell = row.locator('[data-scope="table"][data-part="cell"]').first();
        expect(await cell.evaluate((el) => getComputedStyle(el, '::before').content)).toBe('"Kind"');
        // The head row is read, not seen: clipped to a pixel, off the layout.
        expect(await page.locator('[data-ag-table] [data-scope="table"][data-part="head"]').first().evaluate((el) => `${getComputedStyle(el).position} ${el.getBoundingClientRect().width}`)).toBe('absolute 1');

        await page.goto('/machines');
        const env = page.locator('[data-scope="ag-env-card"][data-part="root"]').first();
        expect((await env.boundingBox())?.height).toBeGreaterThanOrEqual(52);
        expect(await env.evaluate((el) => getComputedStyle(el).display)).toBe('grid');
        await expect(env.locator('[data-scope="ag-pill"]').first()).toBeVisible();
    });

    test('touch targets: buttons are 48 px and the memory row actions grow to 44', async ({ page }) => {
        await page.goto('/agents/a1?tab=memory');
        const action = page.locator('[data-memory-actions] [data-scope="button"]').first();
        const box = (await action.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
        await page.goto('/machines');
        expect((await page.locator(shell('actions')).getByRole('link', { name: 'Pair a machine' }).boundingBox())?.height).toBe(48);
    });
});
