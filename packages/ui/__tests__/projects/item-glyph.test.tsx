/** `ItemGlyph` (#726): the six plan item states as a 16 px square, named in words. */
import { ItemGlyph, type ItemGlyphState } from '@agentic/ui';
import { mount } from '../helpers';

const glyph = (host: ParentNode): HTMLElement => host.querySelector<HTMLElement>('[data-ag-project="item-glyph"]')!;

// happy-dom drops `color-mix()` from inline styles, so the 20 % fills are checked by their border colour.
describe('ItemGlyph', () => {
    it.each<[ItemGlyphState, string, string]>([
        ['ready', 'Ready', 'border-color: var(--ag-text-muted)'],
        ['claimed', 'Claimed', 'border-color: var(--color-info)'],
        ['needs-you', 'Needs you', 'border-color: var(--color-warning)'],
        ['blocked', 'Blocked', 'border-style: dashed'],
        ['done', 'Done', 'background-color: var(--ag-line-strong)'],
        ['stuck', 'Stuck', 'border-color: var(--color-error)']
    ])('draws %s', (state, name, look) => {
        const el = glyph(mount(<ItemGlyph state={state} />));
        expect(el.getAttribute('data-state')).toBe(state);
        expect(el.getAttribute('role')).toBe('img');
        expect(el.getAttribute('aria-label')).toBe(name);
        const style = el.getAttribute('style')!;
        expect(style).toContain('inline-size: 16px');
        expect(style).toContain(look);
        expect(el.querySelector('svg') !== null).toBe(state === 'done');
    });

    it('takes a custom name, or none to be decorative', () => {
        expect(glyph(mount(<ItemGlyph state="claimed" label="Claimed by Forge" />)).getAttribute('aria-label')).toBe('Claimed by Forge');
        const decorative = glyph(mount(<ItemGlyph state="blocked" label="" />));
        expect(decorative.getAttribute('aria-hidden')).toBe('true');
        expect(decorative.hasAttribute('role')).toBe(false);
    });
});
