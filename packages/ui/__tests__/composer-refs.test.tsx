/**
 * The composer's ref suggestions (#940): `#` lists a project's plan items and `pr:` its pull requests from the ref
 * sources the host hands in, a pick inserts the text form `parseRefs` reads, and a visitor's To chip carries its project.
 */
import { describe, it, expect } from 'vitest';
import { parseRefs } from '@agentic/core';
import { Composer, suggestionsFor, type RefSource } from '../src/composer';
import { mount, one, tick } from './helpers';

const people = [
    { id: 'nova', label: 'Nova' },
    { id: 'atlas', label: 'Atlas' }
];
const refs: RefSource[] = [
    { prefix: '#', items: [{ id: '9', label: 'Fix batch()' }, { id: '16', label: 'Bump SignalX' }, { id: '19', label: 'Docs' }] },
    { prefix: 'pr:', items: [{ id: '604', label: 'Rings v2' }, { id: '88', label: 'batch() fix' }] }
];

function textarea(dom: ParentNode): HTMLTextAreaElement {
    return dom.querySelector('textarea')!;
}
function type(dom: ParentNode, value: string): void {
    const ta = textarea(dom);
    ta.value = value;
    ta.setSelectionRange(value.length, value.length);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
}
const popup = (dom: ParentNode): HTMLElement => dom.querySelector<HTMLElement>('[data-scope="ai-composer"][data-part="input"] [data-scope="combobox"][data-part="popup"]')!;
const options = (dom: ParentNode): string[] => [...popup(dom).querySelectorAll<HTMLElement>('[data-scope="combobox"][data-part="item"]')].map((el) => el.textContent ?? '');
const isOpen = (dom: ParentNode): boolean => popup(dom).getAttribute('data-state') === 'open';

describe('suggestionsFor', () => {
    it('lists a source under its prefix, by number or title, as the ref text', () => {
        expect(suggestionsFor('#', people, refs).map((s) => s.label)).toEqual(['#9 Fix batch()', '#16 Bump SignalX', '#19 Docs']);
        expect(suggestionsFor('#1', people, refs).map((s) => s.insert)).toEqual(['#16', '#19']);
        expect(suggestionsFor('#bump', people, refs).map((s) => s.insert)).toEqual(['#16']);
        expect(suggestionsFor('pr:', people, refs).map((s) => s.insert)).toEqual(['pr:604', 'pr:88']);
        expect(suggestionsFor('pr:8', people, refs).map((s) => s.label)).toEqual(['pr:88 batch() fix']);
    });

    it('lists the mentions for @, and nothing for a prefix no source claims', () => {
        expect(suggestionsFor('@n', people, refs)).toEqual([{ key: '@nova', label: 'Nova', insert: '@Nova' }]);
        expect(suggestionsFor('date:', people, refs)).toEqual([]);
        expect(suggestionsFor('#', people, [])).toEqual([]);
    });

    it('prefers the longest prefix that starts the token', () => {
        const nested: RefSource[] = [{ prefix: 'p:', items: [{ id: '1', label: 'short' }] }, { prefix: 'p:x', items: [{ id: '2', label: 'long' }] }];
        expect(suggestionsFor('p:x', [], nested).map((s) => s.insert)).toEqual(['p:x2']);
    });

    it('every insert is one ref parseRefs reads', () => {
        for (const s of [...suggestionsFor('#', [], refs), ...suggestionsFor('pr:', [], refs)]) {
            const found = parseRefs(`see ${s.insert} `);
            expect(found).toHaveLength(1);
            expect(found[0]!.text).toBe(s.insert);
        }
    });
});

describe('the composer with ref sources', () => {
    it('opens on # with the plan items, and a pick inserts the ref', async () => {
        const dom = mount(<Composer onSend={() => {}} mentions={people} refs={refs} />);
        type(dom, 'blocked on #1');
        await tick();
        expect(isOpen(dom)).toBe(true);
        expect(options(dom)).toEqual(['#16 Bump SignalX', '#19 Docs']);
        popup(dom).querySelector<HTMLElement>('[data-scope="combobox"][data-part="item"]')!.click();
        await tick();
        expect(textarea(dom).value).toBe('blocked on #16 ');
    });

    it('opens on pr: with the pull requests, and still on @ with the mentions', async () => {
        const dom = mount(<Composer onSend={() => {}} mentions={people} refs={refs} />);
        type(dom, 'pr:6');
        await tick();
        expect(options(dom)).toEqual(['pr:604 Rings v2']);
        type(dom, 'pr:604 @a');
        await tick();
        expect(options(dom)).toEqual(['Atlas', 'Nova']);
    });

    it('stays shut for a token no source claims, and mid-word', async () => {
        const dom = mount(<Composer onSend={() => {}} mentions={people} refs={refs} />);
        type(dom, 'date:1');
        await tick();
        expect(isOpen(dom)).toBe(false);
        type(dom, 'issue#1');
        await tick();
        expect(isOpen(dom)).toBe(false);
    });

    it('draws a visitor recipient with its project chip', () => {
        const dom = mount(<Composer onSend={() => {}} recipients={[{ id: 'nova', name: 'Nova', project: 'SignalX' }]} hint="@ another project’s PM to bring them in" />);
        const chip = one(dom, 'ai-composer', 'recipient')!;
        expect(chip.querySelector('[data-recipient-project]')?.textContent).toBe('SignalX');
        expect(one(dom, 'ai-composer', 'hint')!.textContent).toBe('@ another project’s PM to bring them in');
    });
});
