import { Agent } from '../../src/pages/Agent';
import { confidencePill, provenanceLine } from '../../src/pages/agent/MemoryTab';
import { agentProfile, memoryCounts } from '../../src/mock/agents';
import { mountAt, text, tick } from './helpers';

const memoryPage = () => mountAt('/agents/a2?tab=memory', <Agent />);

describe('/agents/:id memory tab', () => {
    it('lists every memory in the row grid with kind tag, text, provenance, confidence pill and three labelled actions', async () => {
        const root = await memoryPage();
        const p = agentProfile('a2')!;
        const rows = [...root.querySelectorAll('[data-memory-row]')];
        expect(rows).toHaveLength(p.memories.length);
        for (const [i, row] of rows.entries()) {
            const e = p.memories[i]!;
            expect(row.getAttribute('data-kind')).toBe(e.kind);
            expect(text(row.querySelector('[data-memory-kind] [data-scope="badge"][data-part="root"]'))).toBe(e.kind);
            expect(text(row.querySelector('[data-memory-text]'))).toBe(e.text);
            const pill = confidencePill(e.confidence);
            const pillEl = row.querySelector('[data-memory-confidence] [data-scope="badge"][data-part="root"]')!;
            expect(text(pillEl)).toBe(pill.label);
            expect(pillEl.getAttribute('data-tone')).toBe(pill.tone);
            expect(pillEl.getAttribute('data-variant') === 'outline').toBe(pill.hollow);
            const labels = [...row.querySelectorAll('[data-memory-actions] button')].map((b) => b.getAttribute('aria-label'));
            expect(labels).toEqual(['Correct this memory', 'Retire this memory', 'Delete this memory']);
        }
        // conditions render as tags after "applies when"
        const lesson = rows[0]!;
        expect(text(lesson.querySelector('[data-memory-conditions] > span'))).toBe('applies when');
        expect([...lesson.querySelectorAll('[data-memory-conditions] [data-scope="badge"][data-part="root"]')].map(text)).toEqual(['packages/ui', 'layout', 'a11y']);
        expect(text(lesson.querySelector('[data-memory-provenance]'))).toMatch(/^your correction · /);
    });

    it('filters by kind with counts on aria-pressed chips', async () => {
        const root = await memoryPage();
        const p = agentProfile('a2')!;
        const counts = memoryCounts(p.memories);
        const chips = [...root.querySelectorAll<HTMLButtonElement>('[data-filter-chip]')];
        expect(chips[0]!.getAttribute('data-kind')).toBe('all');
        expect(chips[0]!.getAttribute('aria-pressed')).toBe('true');
        expect(text(chips[0]!.querySelector('[data-filter-count]'))).toBe(String(counts.all));
        // only kinds with entries get a chip
        for (const chip of chips.slice(1)) expect(counts[chip.getAttribute('data-kind') as keyof typeof counts]).toBeGreaterThan(0);

        const lessons = chips.find((c) => c.getAttribute('data-kind') === 'lesson')!;
        expect(text(lessons.querySelector('[data-filter-count]'))).toBe(String(counts.lesson));
        lessons.click();
        await tick();
        expect(lessons.getAttribute('aria-pressed')).toBe('true');
        expect(chips[0]!.getAttribute('aria-pressed')).toBe('false');
        const rows = [...root.querySelectorAll('[data-memory-row]')];
        expect(rows).toHaveLength(counts.lesson);
        for (const row of rows) expect(row.getAttribute('data-kind')).toBe('lesson');
    });

    it('keeps retired rows visible in the retired state with the superseding reason and no correct / retire', async () => {
        const root = await memoryPage();
        const retired = root.querySelector('[data-memory-row][data-retired]')!;
        expect(retired).not.toBeNull();
        expect(text(retired.querySelector('[data-memory-superseded]'))).toBe('superseded by decision 2026-09-17: never link local checkouts');
        expect(retired.querySelector('[data-memory-provenance]')).toBeNull();
        const buttons = [...retired.querySelectorAll<HTMLButtonElement>('[data-memory-actions] button')];
        expect(buttons.map((b) => b.disabled)).toEqual([true, true, false]);

        // retiring a live row moves it into the retired state without removing it
        const live = root.querySelector('[data-memory-row]:not([data-retired])')!;
        const id = live.getAttribute('data-memory-id');
        [...live.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.getAttribute('aria-label') === 'Retire this memory')!.click();
        await tick();
        const after = root.querySelector(`[data-memory-row][data-memory-id="${id}"]`)!;
        expect(after.hasAttribute('data-retired')).toBe(true);
        expect(text(after.querySelector('[data-memory-superseded]'))).toMatch(/^superseded by retired by you/);
    });

    it('renders the rail: scopes with private / shared tags, the runtime note and the learning counters with a switch', async () => {
        const root = await memoryPage();
        const scopes = [...root.querySelectorAll('[data-memory-scopes] li')];
        expect(scopes.map((li) => text(li.querySelector('.mono')))).toEqual(['agent:a2', 'shared:agentic-repo']);
        expect(scopes.map((li) => text(li.querySelector('[data-scope="badge"][data-part="root"]')))).toEqual(['private', 'shared']);
        const sw = root.querySelector<HTMLInputElement>('[data-learning-head] input[role="switch"]')!;
        expect(sw.checked).toBe(true);
        expect(root.querySelector('[data-learning-head] [data-scope="switch"][data-part="root"]')?.getAttribute('data-state')).toBe('checked');
        const counters = [...root.querySelectorAll('[data-learning-counters] div')].map((d) => `${text(d.querySelector('dt'))} ${text(d.querySelector('dd'))}`);
        expect(counters).toEqual(['Corrections this week 1', 'Repeated mistakes 0']);
        expect(root.querySelector<HTMLAnchorElement>('[data-memory-export]')?.getAttribute('download')).toBe('builder-memory.ndjson');
    });

    it('an agent without memories shows the empty state', async () => {
        const root = await mountAt('/agents/a3?tab=memory', <Agent />);
        expect(root.querySelector('[data-memory-row]')).toBeNull();
        expect(text(root.querySelector('[data-scope="empty-state"][data-part="root"]'))).toContain('No memories yet');
    });

    it('provenanceLine and confidencePill follow MEM-06 / MEM-08', () => {
        const p = agentProfile('a2')!;
        expect(provenanceLine(p.memories[1]!)).toBe('verified · task t_5c10 · 16 Sep');
        expect(confidencePill('verified')).toMatchObject({ tone: 'live', hollow: false });
        expect(confidencePill('stated')).toMatchObject({ tone: 'muted', hollow: true });
        expect(confidencePill('assumed')).toMatchObject({ tone: 'needs-you', hollow: true });
    });
});
