/**
 * `FilterChips`: the one filter bar on zero's `ToggleGroup` — a labelled
 * group of `aria-pressed` chips, one value always chosen (pressing the
 * chosen chip keeps it), an optional count per chip, arrow keys between
 * chips, and a posted `name` inside a form. The look is the toggle-group
 * patch's, keyed on `data-filter-chips`.
 */
import { signal } from '@sigx/runtime-core';
import { FilterChips } from '@agentic/ui';
import { patches } from '../../src/design-system';
import { mount, tick } from '../helpers';

const options = [
    { value: 'all', label: 'All', count: 12 },
    { value: 'active', label: 'Active', count: 3 },
    { value: 'failed', label: 'Failed', count: 0 },
    { value: 'archived', label: 'Archived' }
];

const chips = (root: ParentNode) => [...root.querySelectorAll<HTMLButtonElement>('[data-scope="toggle-group"][data-part="item"]')];
const pressed = (root: ParentNode) => chips(root).map((c) => c.getAttribute('aria-pressed'));

describe('FilterChips', () => {
    it('is a labelled group of chips holding one value', async () => {
        const state = signal({ filter: 'active' });
        const changes: string[] = [];
        const root = mount(<FilterChips label="Filter by status" options={options} model={() => state.filter} onValueChange={(v) => changes.push(v)} />);
        const group = root.querySelector('[data-scope="toggle-group"][data-part="root"]')!;
        expect(group.getAttribute('role')).toBe('group');
        expect(group.getAttribute('aria-label')).toBe('Filter by status');
        expect(group.hasAttribute('data-filter-chips')).toBe(true);
        expect(chips(root).every((c) => c.tagName === 'BUTTON' && c.type === 'button')).toBe(true);
        expect(pressed(root)).toEqual(['false', 'true', 'false', 'false']);

        chips(root)[2]!.click();
        await tick();
        expect(state.filter).toBe('failed');
        expect(changes).toEqual(['failed']);
        expect(pressed(root)).toEqual(['false', 'false', 'true', 'false']);

        // A model change from outside moves the selection.
        state.filter = 'all';
        await tick();
        expect(pressed(root)).toEqual(['true', 'false', 'false', 'false']);
    });

    it('is not deselectable: pressing the chosen chip keeps it chosen', async () => {
        const state = signal({ filter: 'all' });
        const root = mount(<FilterChips label="Filter" options={options} model={() => state.filter} />);
        chips(root)[0]!.click();
        await tick();
        expect(state.filter).toBe('all');
        expect(pressed(root)).toEqual(['true', 'false', 'false', 'false']);
    });

    it('shows a count after the label when the chip has one — zero included — and none otherwise', () => {
        const root = mount(<FilterChips label="Filter" options={options} model={() => 'all'} />);
        const counts = chips(root).map((c) => c.querySelector('[data-chip-count]')?.textContent ?? null);
        expect(counts).toEqual(['12', '3', '0', null]);
        expect(chips(root)[1]!.textContent).toBe('Active3');
    });

    it('moves between chips with the arrow keys and chooses with Enter / Space (a native button click)', async () => {
        const state = signal({ filter: 'all' });
        const root = mount(<FilterChips label="Filter" options={options} model={() => state.filter} />);
        const [all, active] = chips(root);
        // One tab stop: the chosen chip.
        expect(chips(root).map((c) => c.tabIndex)).toEqual([0, -1, -1, -1]);
        all!.focus();
        all!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        await tick();
        expect(document.activeElement).toBe(active);
        // Arrows rove focus without choosing.
        expect(state.filter).toBe('all');
        // Enter and Space on a native button activate it as a click.
        active!.click();
        await tick();
        expect(state.filter).toBe('active');
    });

    it('posts its value under `name` inside a form', async () => {
        const state = signal({ filter: 'failed' });
        const root = mount(<form><FilterChips label="Filter" name="status" options={options} model={() => state.filter} /></form>);
        await tick();
        const form = root.querySelector('form')!;
        expect(new FormData(form).getAll('status')).toEqual(['failed']);
        chips(root)[1]!.click();
        await tick();
        expect(new FormData(form).getAll('status')).toEqual(['active']);
    });

    it('draws the chip in the toggle-group patch, not in page CSS', () => {
        const item = patches['toggle-group']!.parts!['item']!.selectors!;
        expect(item['[data-filter-chips] > &']).toMatchObject({ height: 'var(--ag-pill-h)', fontFamily: 'var(--font-mono)' });
        expect(item['[data-filter-chips] > &[data-state="on"]']).toMatchObject({ background: 'color-mix(in oklab, var(--color-primary) 15%, transparent)' });
    });
});
