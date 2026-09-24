import { test, expect, type Locator, type Page } from '@playwright/test';

/**
 * The phone regime (#91, `docs/design/HANDOFF.md` → "Responsive behaviour",
 * "Mobile specifics"): every route fits 400 px with no horizontal scroll,
 * the drawer opens and closes with focus back on its trigger, the composer
 * docks with 48 px controls, and the approval card's `Allow once` takes the
 * full row. Project `phone-400` only.
 */
const shell = (part: string) => `[data-scope="ai-shell"][data-part="${part}"]`;
/** The shell's navigation drawer — the responsive one; the chat's context panel is a plain modal drawer. */
const drawerPanel = '[data-scope="drawer"][data-part="panel"][data-l-dock-above="md"]';

const ROUTES = ['/', '/chats/c1', '/projects', '/projects/new', '/projects/p_agentic', '/tasks/t1-1', '/sessions/s1', '/agents', '/agents/a1', '/machines', '/machines/alien01', '/pair', '/schedules', '/plugins', '/plugins?kind=connector', '/plugins/connectors/add', '/plugins/connectors/add?selected=gmail', '/plugins/gmail', '/settings', '/history', '/usage'];

async function noHorizontalScroll(page: Page, path: string) {
    const [scrollWidth, innerWidth] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    expect(scrollWidth, `${path} scrolls horizontally`).toBeLessThanOrEqual(innerWidth);
}

/**
 * The drawer slides in (zero-daisyui's sheet slide, `--duration-slow`), and while its `translate` is animating the panel sits on a
 * composited layer at a fractional offset — every box inside it then measures
 * a hair off (44.00001…, 20.000001…), so exact `toBe(n)` sizes flake (#276).
 * Waiting for the element's own and its subtree's animations to finish puts
 * the panel back on whole pixels. A cancelled animation rejects `finished`;
 * that only means the drawer moved on, so it is not an error here.
 */
async function animationsSettled(locator: Locator): Promise<void> {
    await locator.evaluate(async (el) => {
        await Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => undefined)));
    });
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
        // A root route shows the menu; the docked sidebar is gone; the title is the page.
        await expect(page.locator(drawerPanel)).toBeHidden();
        const menu = page.getByRole('button', { name: 'Menu' });
        expect((await menu.boundingBox())?.width).toBe(44);
        await expect(page.locator(shell('title-text'))).toHaveText('Home');

        await menu.click();
        const panel = page.locator(drawerPanel);
        await expect(panel).toBeVisible();
        // Measure only once the slide has finished, or every box inside reads a sub-pixel off (#276).
        await animationsSettled(panel);
        expect(Math.round((await panel.boundingBox())?.width ?? 0)).toBe(312);
        const item = panel.locator('[data-scope="nav-list"][data-part="link"]').first();
        expect(Math.round((await item.boundingBox())?.height ?? 0)).toBe(50);
        expect(await item.evaluate((a) => getComputedStyle(a).fontSize)).toBe('16px');
        expect(Math.round(await item.locator('svg').evaluate((s) => s.getBoundingClientRect().width))).toBe(20);
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
        const drawer = page.locator('[data-scope="drawer"][data-part="panel"]').filter({ has: page.locator('[data-context-drawer]') });
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
        // zero's stacked mode (`Table.Root stack="md"`): each row one block, each cell opening with its column's label.
        const table = page.locator('[data-scope="table"][data-part="root"][data-l-stack="md"]').first();
        const row = table.locator('[data-scope="table"][data-part="body"] > [data-scope="table"][data-part="row"]').first();
        expect(await row.evaluate((el) => getComputedStyle(el).display)).toBe('block');
        const cell = row.locator('[data-scope="table"][data-part="cell"]').first();
        await expect(cell.locator('[data-scope="table"][data-part="cell-label"]')).toHaveText('Kind');
        await expect(cell.locator('[data-scope="table"][data-part="cell-label"]')).toBeVisible();
        // The actions column is named for assistive tech only, so its cell prints no label.
        expect(await row.locator('[data-scope="table"][data-part="cell"]').last().locator('[data-part="cell-label"]').count()).toBe(0);
        // The head row is read, not seen: clipped to a pixel, off the layout.
        expect(await table.locator('[data-scope="table"][data-part="head"]').evaluate((el) => `${getComputedStyle(el).position} ${el.getBoundingClientRect().width}`)).toBe('absolute 1');

        await page.goto('/machines');
        const env = page.locator('[data-scope="ag-env-card"][data-part="root"]').first();
        expect((await env.boundingBox())?.height).toBeGreaterThanOrEqual(52);
        expect(await env.evaluate((el) => getComputedStyle(el).display)).toBe('grid');
        await expect(env.locator('[data-scope="badge"][data-part="root"]').first()).toBeVisible();
    });

    test('plugins (#641): the category Select above the list, stacked rows, 44 px targets', async ({ page }) => {
        await page.goto('/plugins?kind=harness');
        // The menu column is gone; its items are one Select above the content, on the current category.
        await expect(page.getByRole('navigation', { name: 'Plugin categories' })).toBeHidden();
        const trigger = page.locator('[data-plugins-select] [data-scope="select"][data-part="trigger"]');
        await expect(trigger).toBeVisible();
        await expect(trigger).toContainText('Harness');
        const [t, search] = await Promise.all([trigger.boundingBox(), page.getByRole('searchbox', { name: 'Search plugins' }).boundingBox()]);
        expect(t!.height).toBeGreaterThanOrEqual(44);
        expect(t!.y + t!.height).toBeLessThanOrEqual(search!.y);
        await trigger.click();
        await page.getByRole('option', { name: /^Memory/ }).click();
        await expect(page).toHaveURL(/\/plugins\?kind=memory$/);

        // A row stacks: the tile, the name over the readiness pill, then the switch; the chevron is hidden.
        await page.goto('/plugins');
        const row = page.locator('[data-plugin-rows] [data-plugin-row="default"][data-plugin="claude-code"]');
        const part = (name: string) => row.locator(`[data-plugin-row-part="${name}"]`);
        await expect(part('chevron')).toBeHidden();
        await expect(part('kind')).toBeHidden();
        await expect(part('readiness')).toBeVisible();
        const [tile, name, pill, toggle] = await Promise.all([part('tile').boundingBox(), part('name').boundingBox(), part('readiness').boundingBox(), part('toggle').boundingBox()]);
        expect(name!.x).toBeGreaterThan(tile!.x + tile!.width - 1);
        expect(pill!.y).toBeGreaterThanOrEqual(name!.y + name!.height - 1);
        expect(Math.round(pill!.x)).toBe(Math.round(name!.x));
        expect(toggle!.x).toBeGreaterThan(name!.x + name!.width - 1);
        // Touch targets: the switch, the status chips and the Select are 44 px.
        const sw = await row.locator('[data-scope="switch"][data-part="root"]').boundingBox();
        expect(sw!.height).toBeGreaterThanOrEqual(44);
        expect(sw!.width).toBeGreaterThanOrEqual(44);
        for (const chip of await page.locator('[data-status-chip]').all()) expect((await chip.boundingBox())!.height).toBeGreaterThanOrEqual(44);

        // The Connectors view stacks the same way, with no sideways scroll.
        await page.goto('/plugins?kind=connector');
        const connector = page.locator('[data-connector-rows] [data-plugin-row="connector"]').first();
        await expect(connector.locator('[data-plugin-row-part="chevron"]')).toBeHidden();
        await expect(connector.locator('[data-plugin-row-part="readiness"]')).toBeVisible();
        await noHorizontalScroll(page, '/plugins?kind=connector');
    });

    test('add a connector (#641): one column, the preview a full-screen sheet with Connect docked at the foot', async ({ page }) => {
        await page.goto('/plugins/connectors/add');
        // One column: the browse column first, the filters under it; no preview until one is picked.
        const [main, side] = await Promise.all([page.locator('[data-add-main]').boundingBox(), page.locator('[data-add-side]').boundingBox()]);
        expect(side!.y).toBeGreaterThanOrEqual(main!.y + main!.height - 1);
        expect(Math.round(side!.x)).toBe(Math.round(main!.x));
        await expect(page.locator('[data-add-preview]')).toBeHidden();

        await page.locator('[data-add-main] button[data-connector="gmail"]').click();
        const sheet = page.locator('[data-add-preview][data-sheet]');
        await expect(sheet).toBeVisible();
        const viewport = page.viewportSize()!;
        const box = (await sheet.boundingBox())!;
        expect([Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)]).toEqual([0, 0, viewport.width, viewport.height]);
        const connect = sheet.getByRole('button', { name: 'Connect Gmail' });
        const foot = (await sheet.locator('[data-preview-foot]').boundingBox())!;
        expect(Math.round(foot.y + foot.height)).toBe(viewport.height);
        expect((await connect.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        const close = sheet.getByRole('button', { name: 'Close preview' });
        expect((await close.boundingBox())!.width).toBeGreaterThanOrEqual(44);
        // It is a modal: a named dialog, focus moved to its Close, the columns under it inert.
        await expect(page.getByRole('dialog', { name: 'Gmail' })).toBeVisible();
        await expect(sheet).toHaveAttribute('aria-modal', 'true');
        await expect(close).toBeFocused();
        await expect(page.locator('[data-add-main]')).toHaveAttribute('inert', /.*/);
        await expect(page.locator('[data-add-side]')).toHaveAttribute('inert', /.*/);
        await close.click();
        await expect(sheet).toBeHidden();
        await expect(page).not.toHaveURL(/selected=/);
        await expect(page.locator('[data-add-main]')).not.toHaveAttribute('inert', /.*/);

        // Escape closes it too, and focus goes back to the tile that opened it.
        const tile = page.locator('[data-add-main] button[data-connector="gmail"]');
        await tile.click();
        await expect(close).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(sheet).toBeHidden();
        await expect(page).not.toHaveURL(/selected=/);
        await expect(tile).toBeFocused();

        // Connect from the sheet runs the flow to the agent step, which the sheet no longer covers.
        await page.locator('[data-add-main] button[data-connector="gmail"]').click();
        await page.locator('[data-add-preview][data-sheet]').getByRole('button', { name: 'Connect Gmail' }).click();
        await expect(page.getByRole('heading', { name: 'Choose agents for Gmail' })).toBeVisible();
        await expect(page.locator('[data-add-preview]')).toBeHidden();
        await noHorizontalScroll(page, '/plugins/connectors/add?next=agents');
    });

    test('the plugin page (#641): the header wraps, the rail drops under the main column', async ({ page }) => {
        await page.goto('/plugins/gmail');
        const [main, rail] = await Promise.all([page.locator('[data-plugin-detail-main]').boundingBox(), page.locator('[data-plugin-detail-rail]').boundingBox()]);
        expect(rail!.y).toBeGreaterThanOrEqual(main!.y + main!.height - 1);
        expect(Math.round(rail!.x)).toBe(Math.round(main!.x));
        const deny = page.locator('[data-tool-policy="gmail__send-email"]').getByRole('button', { name: 'deny' });
        expect((await deny.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        await noHorizontalScroll(page, '/plugins/gmail');
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
