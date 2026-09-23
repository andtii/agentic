import { test, expect } from '@playwright/test';

/**
 * The agent pages at 1280 (issue #89): roster → card → Config tab → Memory
 * tab, every Config field labelled. The phone project only checks the
 * roster renders; the mobile pass (#91) owns the rest.
 */
test('roster → agent → Config → Memory, with every config field labelled', async ({ page }, info) => {
    await page.goto('/agents');
    await expect(page.locator('[data-page-title]')).toHaveText('Agents');
    const cards = page.locator('[data-agent-grid] a.agent-card');
    await expect(cards).toHaveCount(3);
    // whole card is the link; the footer stats read config / memories / corrections
    const builder = page.locator('[data-agent-card="a2"] a.agent-card');
    await expect(builder.locator('[data-agent-card-stats] dt')).toHaveText(['config', 'memories', 'corrections / wk']);
    await expect(page.locator('[data-agent-card="a3"] [data-agent-card-noenv]')).toHaveText('No environment');

    if (info.project.name !== 'desktop-1280') return; // the phone and tablet regimes are #91's specs

    // two equal columns at 1280
    const first = await cards.nth(0).boundingBox();
    const second = await cards.nth(1).boundingBox();
    expect(first && second && Math.abs(first.width - second.width) < 2).toBe(true);
    expect(first && second && second.x > first.x + first.width).toBe(true);

    await builder.click();
    await expect(page).toHaveURL(/\/agents\/a2$/);
    await expect(page.locator('[data-page-title]')).toHaveText('Builder');
    await expect(page.locator('[role="tab"][aria-selected="true"]')).toHaveText('Overview');

    await page.getByRole('tab', { name: 'Config' }).click();
    await expect(page.locator('[role="tab"][aria-selected="true"]')).toHaveText('Config');
    const form = page.locator('form[data-form="agent"]');
    await expect(form).toBeVisible();
    // fluid form + 360 rail
    const rail = page.locator('[data-scope="ai-form"][data-part="rail"]');
    expect((await rail.boundingBox())?.width).toBe(360);
    await expect(page.locator('[data-save-card]')).toHaveCount(0);
    await expect(page.locator('[data-versions-list] [data-scope="ag-version"][data-part="root"]')).toHaveCount(5);

    // every visible control has a visible label (Field.Label, wrapping label, or aria-label). A zero Select is its
    // `combobox` trigger; the `<select>` it posts through is aria-hidden and never a control anyone sees.
    const unlabelled = await form.evaluate((f) => {
        const els = [...f.querySelectorAll<HTMLElement>('input:not([type="hidden"]), textarea, select, [role="combobox"], [role="group"][aria-label]')];
        return els
            .filter((el) => {
                if (el.getAttribute('aria-hidden') === 'true') return false;
                if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return false;
                const forLabel = el.id ? f.querySelector(`label[for="${el.id}"]`) : null;
                return !(forLabel || el.closest('label'));
            })
            .map((el) => `${el.tagName}:${el.getAttribute('name')}`);
    });
    expect(unlabelled).toEqual([]);

    // an edit shows the save card in the rail
    await page.locator(`input[name="name"]`).fill('Builder 2');
    await expect(page.locator('[data-save-card]')).toBeVisible();
    await expect(page.locator('[data-save-card] button[type="submit"]')).toHaveText('Save as v12');

    await page.getByRole('tab', { name: 'Memory' }).click();
    await expect(page.locator('[role="tab"][aria-selected="true"]')).toHaveText('Memory');
    await expect(page.locator('[data-memory-row]')).toHaveCount(7);
    await expect(page.locator('[data-memory-row][data-retired]')).toHaveCount(1);
    // the filter chips are pressed buttons with counts
    await page.locator('[data-filter-chip][data-kind="lesson"]').click();
    await expect(page.locator('[data-filter-chip][data-kind="lesson"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-memory-row]')).toHaveCount(3);
    // fluid list + 320 rail
    expect((await page.locator('[data-memory-rail]').boundingBox())?.width).toBe(320);
});
