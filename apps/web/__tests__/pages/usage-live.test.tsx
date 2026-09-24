/**
 * `/usage` and Home's spend over the real wire (#146, OPS-07): the month's
 * Ledger summarised by agent, task and day — a reported cost, an estimated
 * one and an unpriced turn read as three distinct things in the table, the
 * cards and the spend panel; `n/a` where nothing was priced, never 0.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LedgerActor, ledgerKey, ledgerMonth, type LedgerRow } from '@agentic/platform';
import { WS, mountLive, owner, startLive, until, type LiveHarness } from './live-harness';
import { buttonNamed, cellText, text } from './helpers';

let h: LiveHarness;
beforeEach(async () => {
    h = await startLive();
});
afterEach(async () => {
    await h.stop();
});

const rows = (dom: ParentNode) => [...dom.querySelectorAll<HTMLElement>('[data-usage-row]')];
const cell = (row: Element, n: number) => cellText(row.querySelectorAll('td')[n]);
const stat = (dom: ParentNode, label: string) => dom.querySelector(`[data-stat][aria-label="${label}"]`)!;

/** Three agents in one month: Atlas fully reported, Scout partly estimated, Forge never priced (a daemon runtime). */
async function seed() {
    const now = Date.now();
    const month = ledgerMonth(now);
    const atlas = await h.agent('Atlas', 'Coordinates');
    const scout = await h.agent('Scout', 'Researches');
    const forge = await h.agent('Forge', 'Builds');
    const ledger = h.app.as(owner).actor(LedgerActor, ledgerKey(WS, month));
    const day = 24 * 60 * 60_000;
    // Keep every row inside the month: back off only as far as the month allows.
    const back = (days: number): number => Math.max(new Date(`${month}-01T00:00:00Z`).getTime() + 1, now - days * day);
    const row = (key: string, agentId: string, at: number, extra: Partial<LedgerRow> = {}): LedgerRow => ({ key, at, sessionId: `s_${key}`, agentId, usage: { inputTokens: 1_000, outputTokens: 500 }, estimated: false, ...extra });
    await ledger.append(row('a1', atlas, back(2), { taskId: 't_plan', costUsd: 1.2 }));
    await ledger.append(row('a2', atlas, back(1), { taskId: 't_plan', costUsd: 0.8 }));
    await ledger.append(row('s1', scout, back(1), { taskId: 't_research', costUsd: 0.5 }));
    await ledger.append(row('s2', scout, now, { taskId: 't_research', costUsd: 0.3, estimated: true }));
    await ledger.append(row('f1', forge, now, { taskId: 't_build' }));
    await ledger.append(row('f2', forge, now));
    return { atlas, scout, forge, month };
}

describe('/usage (live)', () => {
    it('shows reported and estimated cost distinctly, and not-reported as such, by agent, task and day', async () => {
        const { atlas, scout, forge } = await seed();
        const dom = await mountLive('/usage', h);
        await until(() => rows(dom).length === 3, 'the three agent rows');
        const byId = (id: string) => rows(dom).find((r) => r.getAttribute('data-usage-row') === id)!;
        // Atlas: two turns, every cost reported by the provider.
        expect(byId(atlas).getAttribute('data-quality')).toBe('reported');
        expect(cell(byId(atlas), 1)).toBe('2');
        expect(cell(byId(atlas), 2)).toBe('3.0k');
        expect(cell(byId(atlas), 3)).toBe('$2.00');
        expect(text(byId(atlas).querySelector('[data-scope="badge"][data-part="root"]'))).toBe('REPORTED');
        // Scout: one reported, one guessed — two figures, the tilde only on the estimate.
        expect(byId(scout).getAttribute('data-quality')).toBe('partly-estimated');
        expect(cell(byId(scout), 3)).toBe('$0.50 + ~$0.30');
        expect(text(byId(scout).querySelector('[data-scope="badge"][data-part="root"]'))).toBe('PARTLY ESTIMATED');
        // Forge: tokens known, no cost at all — `n/a` in the dim ink, never 0.
        expect(byId(forge).getAttribute('data-quality')).toBe('not-reported');
        expect(cell(byId(forge), 2)).toBe('3.0k');
        expect(cell(byId(forge), 3)).toBe('n/a');
        expect(byId(forge).querySelector('[data-cost]')!.hasAttribute('data-dim')).toBe(true);
        expect(text(byId(forge).querySelector('[data-scope="badge"][data-part="root"]'))).toBe('NOT REPORTED');
        expect(text(byId(forge).querySelector('[data-agent-cell] > span:nth-child(2)'))).toBe('Forge');

        // The cards: the month's total split into its reported and estimated parts, the guessed and the unpriced turns counted.
        expect(text(stat(dom, 'Estimated share').querySelector('[data-stat-value]'))).toBe('~$0.30');
        // Each card is zero's Stats (#594); an estimate colours its figure through the Stats colour.
        expect([stat(dom, 'Estimated share').getAttribute('data-scope'), stat(dom, 'Estimated share').getAttribute('data-color')]).toEqual(['stats', 'warning']);
        expect(stat(dom, 'Not reported').hasAttribute('data-color')).toBe(false);
        expect(stat(dom, 'Not reported').querySelector('[data-scope="stats"][data-part="value"]')).toBe(stat(dom, 'Not reported').querySelector('[data-stat-value]'));
        expect(text(stat(dom, 'Not reported').querySelector('[data-stat-value]'))).toBe('2 turns');
        expect(text(stat(dom, 'Turns recorded').querySelector('[data-stat-value]'))).toBe('6');
        const spend = dom.querySelector('[data-stat][aria-label$="spend"]')!;
        expect(text(spend.querySelector('[data-stat-value]'))).toBe('$2.80');
        expect(text(spend.querySelector('[data-stat-caption]'))).toBe('$2.50 reported + $0.30 estimated');
        expect(dom.querySelectorAll('[data-bar]').length).toBeGreaterThan(0);

        // By task: the unattributed chat turn is its own row; the quality column follows each group.
        buttonNamed(dom, 'By task').click();
        await until(() => rows(dom).length === 4, 'the task rows');
        expect(rows(dom).map((r) => r.getAttribute('data-usage-row')).sort()).toEqual(['(none)', 't_build', 't_plan', 't_research']);
        expect(rows(dom).find((r) => r.getAttribute('data-usage-row') === '(none)')!.getAttribute('data-quality')).toBe('not-reported');
        expect(cell(rows(dom).find((r) => r.getAttribute('data-usage-row') === 't_research')!, 3)).toBe('$0.50 + ~$0.30');

        // By day: today's row carries the guessed cost and the unpriced turns.
        buttonNamed(dom, 'By day').click();
        await until(() => rows(dom).length >= 1 && rows(dom).every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.getAttribute('data-usage-row')!)), 'the day rows');
        expect(rows(dom)[0]!.getAttribute('data-quality')).toBe('partly-estimated');
    });

    it('with nothing recorded prints n/a everywhere, and Home says the same', { timeout: 15_000 }, async () => {
        await h.agent('Atlas');
        const dom = await mountLive('/usage', h);
        await until(() => dom.querySelector('[data-usage-empty]') !== null, 'the empty note');
        expect(rows(dom)).toEqual([]);
        expect(text(dom.querySelector('[data-stat][aria-label$="spend"] [data-stat-value]'))).toBe('n/a');
        expect(text(stat(dom, 'Not reported').querySelector('[data-stat-value]'))).toBe('0 turns');
        const home = await mountLive('/', h);
        await until(() => home.querySelector('[data-spend-value]') !== null && !home.querySelector('[data-spend]')!.hasAttribute('aria-busy'), 'the spend panel');
        expect(text(home.querySelector('[data-spend-value]'))).toBe('n/a');
        expect(home.querySelector('[data-spend]')!.getAttribute('data-quality')).toBe('not-reported');
    });

    it('Home shows the month with its estimated part marked', async () => {
        await seed();
        const home = await mountLive('/', h);
        await until(() => text(home.querySelector('[data-spend-value]')) === '$2.50 + ~$0.30', 'the spend value');
        expect(home.querySelector('[data-spend]')!.getAttribute('data-quality')).toBe('partly-estimated');
        expect(text(home.querySelector('[data-spend]')!.parentElement!.querySelector('[data-panel-note]'))).toContain('priced at a guessed rate');
    });
});
