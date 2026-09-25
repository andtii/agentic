import { test, expect, type Page } from '@playwright/test';

/**
 * The projects redesign at the three widths (#766, PRJ-19; `docs/design/HANDOFF.md` → "Responsive behaviour"): no
 * project page scrolls sideways, the fixed right rails drop under the main column below 1280, three-column grids
 * become two and then one, and the main flows work end to end on mock data — open a project, its sub-menu to Work,
 * a pull request; the Plan list to the board and a drag; accepting a request; the phone's drawer and back link.
 * Board and link-graph canvases scroll inside their own box by design; only the page itself must not.
 */
const shell = (part: string) => `[data-scope="ai-shell"][data-part="${part}"]`;
const drawerPanel = '[data-scope="drawer"][data-part="panel"][data-l-dock-above="md"]';

const ROUTES = [
    '/projects',
    '/projects/links',
    '/projects/new',
    '/projects/p_agentic',
    '/projects/p_agentic/chats',
    '/projects/p_agentic/work',
    '/projects/p_agentic/work/pr:602',
    '/projects/p_agentic/work/t_93d1',
    '/projects/p_agentic/requests',
    '/projects/p_agentic/plan',
    '/projects/p_agentic/plan?view=board',
    '/projects/p_agentic/plan?view=graph',
    '/projects/p_agentic/code',
    '/projects/p_agentic/settings/general',
    '/projects/p_agentic/settings/members',
    '/projects/p_agentic/settings/folders',
    '/projects/p_agentic/settings/connectors',
    '/projects/p_agentic/settings/features',
    '/projects/p_agentic/settings/manager',
    '/projects/p_docs',
    '/projects/p_docs/work'
];

const width = (page: Page): number => page.viewportSize()?.width ?? 0;
const columns = (page: Page, selector: string): Promise<number> =>
    page.locator(selector).first().evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
const cardsIn = (page: Page, column: string): Promise<string[]> =>
    page.locator(`[data-plan-board-column="${column}"] [data-plan-card]`).evaluateAll((cs) => cs.map((c) => c.getAttribute('data-plan-card') ?? ''));

// One test per route: the dev server renders each page on demand, so a loop over all of them outruns one test's timeout.
for (const path of ROUTES) {
    test(`${path} does not scroll horizontally, and does not throw`, async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto(path);
        await expect(page.locator(shell('main'))).toBeVisible();
        const [scrollWidth, innerWidth] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
        expect(scrollWidth, `${path} scrolls horizontally`).toBeLessThanOrEqual(innerWidth);
        expect(errors, errors.join('\n')).toEqual([]);
    });
}

test('open a project, go to Work, open a pull request', async ({ page }) => {
    await page.goto('/projects');
    await page.locator('main a[href="/projects/p_agentic"]').first().click();
    await expect(page).toHaveURL(/\/projects\/p_agentic$/);
    await expect(page.locator('[data-overview-main]')).toBeVisible();

    if (width(page) >= 768) {
        // The docked sidebar carries the project's sub-menu under Projects.
        const nav = page.locator(drawerPanel);
        await expect(nav.locator('[data-scope="nav-list"][data-part="link"][href="/projects/p_agentic"]')).toHaveAttribute('aria-current', 'page');
        await nav.locator('[data-scope="nav-list"][data-part="link"][href="/projects/p_agentic/work"]').click();
    } else {
        // The phone has no sidebar on a project page (a back link instead of Menu): Overview links to Work.
        await page.locator('[data-overview-main]').getByRole('link', { name: 'All work →' }).click();
    }
    await expect(page).toHaveURL(/\/projects\/p_agentic\/work$/);

    await page.locator('[data-work-title] a[href="/projects/p_agentic/work/pr:602"]').click();
    await expect(page).toHaveURL(/\/projects\/p_agentic\/work\/pr:602$/);
    await expect(page.locator('[data-pull-title]')).toHaveText('Make the drawer collapse below 768 px');
    await expect(page.getByRole('complementary', { name: 'Pull request actions' })).toBeVisible();
});

test('Plan list to board, then move a card to another agent', async ({ page }) => {
    await page.goto('/projects/p_agentic/plan');
    await expect(page.locator('[data-plan-view="list"]')).toBeVisible();
    await page.getByRole('navigation', { name: 'Plan view' }).getByRole('link', { name: 'Board' }).click();
    await expect(page).toHaveURL(/view=board/);
    await expect(page.locator('[data-plan-view="board"]')).toBeVisible();
    expect(await cardsIn(page, 'agent:forge')).toContain('11');

    const card = page.locator('[data-plan-card="11"]');
    if (width(page) >= 768) {
        await card.dragTo(page.locator('[data-plan-board-column="agent:lint"]'));
    } else {
        // Below 768 the columns scroll sideways one at a time; the keyboard path moves the card across.
        await card.focus();
        await page.keyboard.press(' ');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press(' ');
    }
    await expect(page.locator('[data-plan-board-live]')).toContainText('Moved #11 to Lint');
    expect(await cardsIn(page, 'agent:lint')).toContain('11');
    expect(await cardsIn(page, 'agent:forge')).not.toContain('11');
});

test('accept an incoming request as proposed', async ({ page }) => {
    await page.goto('/projects/p_agentic/requests');
    const row = page.locator('[data-requests-row="req_7c2a"]');
    await expect(row).toHaveAttribute('data-state', 'needs-you');
    await page.getByRole('button', { name: 'Accept as proposed' }).click();
    await expect(row).toHaveAttribute('data-state', 'accepted');
    await expect(row.locator('[data-requests-row-note="result"]')).toHaveText(/→ agentic#\d+/);
    await expect(page.getByRole('button', { name: 'Accept as proposed' })).toHaveCount(0);
});

test.describe('phone', () => {
    test.skip(({ viewport }) => (viewport?.width ?? 0) >= 768, 'the phone regime');

    test('the drawer opens from /projects, a project page gets a back link, and grids are one column', async ({ page }) => {
        await page.goto('/projects');
        const menu = page.getByRole('button', { name: 'Menu' });
        await menu.click();
        const panel = page.locator(drawerPanel);
        await expect(panel).toBeVisible();
        await expect(panel.locator('[data-scope="nav-list"][data-part="link"][href="/projects"]')).toHaveAttribute('aria-current', 'page');
        await page.keyboard.press('Escape');
        await expect(panel).toBeHidden();
        await expect(menu).toBeFocused();
        expect(await columns(page, '[data-projects-grid]')).toBe(1);

        await page.goto('/projects/p_agentic/work');
        await expect(page.getByRole('button', { name: 'Menu' })).toBeHidden();
        await page.locator(shell('back')).getByRole('link', { name: 'Back' }).click();
        await expect(page).toHaveURL(/\/projects\/p_agentic$/);

        await page.goto('/projects/p_agentic/settings/features');
        expect(await columns(page, '[data-features-catalogue]')).toBe(1);
        await page.goto('/projects/p_agentic/chats');
        expect(await columns(page, '[data-project-chat-row]')).toBe(2);
    });
});

test.describe('rails and grids by width', () => {
    test.skip(({ viewport }) => (viewport?.width ?? 0) < 768, 'the sidebar regimes');

    test('fixed right rails sit beside the main column at 1280 and drop under it below', async ({ page }) => {
        const wide = width(page) >= 1280;
        const rails = wide ? 2 : 1;
        await page.goto('/projects/p_agentic');
        expect(await columns(page, '[data-page="project-overview"]')).toBe(rails);
        const [main, rail] = await Promise.all([page.locator('[data-overview-main]').boundingBox(), page.locator('[data-overview-rail]').boundingBox()]);
        if (wide) expect(rail!.x).toBeGreaterThan(main!.x + main!.width - 1);
        else expect(rail!.y).toBeGreaterThanOrEqual(main!.y + main!.height - 1);

        await page.goto('/projects/p_agentic/work/pr:602');
        expect(await columns(page, '[data-pull-board]')).toBe(rails);
        await page.goto('/projects/p_agentic/requests');
        expect(await columns(page, '[data-requests-body]')).toBe(rails);
        await page.goto('/projects/p_agentic/settings/features');
        expect(await columns(page, '[data-features-grid]')).toBe(rails);
    });

    test('three-column card grids become two below 1280', async ({ page }) => {
        const cols = width(page) >= 1280 ? 3 : 2;
        await page.goto('/projects');
        expect(await columns(page, '[data-projects-grid]')).toBe(cols);
        await page.goto('/projects/p_agentic/settings/features');
        expect(await columns(page, '[data-features-catalogue]')).toBe(cols);
    });
});
