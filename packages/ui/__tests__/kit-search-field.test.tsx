/**
 * `SearchField` (#629): a `role="search"` landmark over zero's `Input` with a
 * visually hidden label and a `/` hint; `/` focuses it from the page but not
 * while typing in another field; the listener leaves with the component.
 */
import { signal } from '@sigx/runtime-core';
import { SearchField, isTypingTarget } from '@agentic/ui';
import { mount, tick, unmountAll } from './helpers';

function press(target: EventTarget, key = '/'): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
}

const searchInput = (root: ParentNode): HTMLInputElement => root.querySelector<HTMLInputElement>('[role="search"] input')!;

describe('SearchField', () => {
    it('is a search landmark with a visually hidden label, a placeholder and a / hint', () => {
        const root = mount(<SearchField label="Search plugins" placeholder="Search plugins, tools and permissions" />);
        const search = root.querySelector('[role="search"]')!;
        const input = searchInput(root);
        expect(input.type).toBe('search');
        expect(input.placeholder).toBe('Search plugins, tools and permissions');
        const label = search.querySelector('label')!;
        expect(label.textContent).toBe('Search plugins');
        expect(label.hasAttribute('data-visually-hidden')).toBe(true);
        expect(label.getAttribute('for')).toBe(input.id);
        const hint = search.querySelector<HTMLElement>('[data-scope="kbd"]')!;
        expect(hint.textContent).toBe('/');
        expect(hint.getAttribute('aria-hidden')).toBe('true');
        expect(input.getAttribute('aria-keyshortcuts')).toBe('/');
    });

    it('binds its model', async () => {
        const st = signal({ q: 'git' });
        const root = mount(<SearchField label="Search" model={() => st.q} />);
        const input = searchInput(root);
        expect(input.value).toBe('git');
        input.value = 'gmail';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await tick();
        expect(st.q).toBe('gmail');
    });

    it('focuses on / from the page and prevents the default', () => {
        const root = mount(<SearchField label="Search" />);
        const event = press(document.body);
        expect(document.activeElement).toBe(searchInput(root));
        expect(event.defaultPrevented).toBe(true);
    });

    it('ignores / typed into another input, a textarea or a contenteditable', () => {
        const root = mount(<SearchField label="Search" />);
        const other = document.createElement('input');
        const area = document.createElement('textarea');
        const editable = document.createElement('div');
        editable.setAttribute('contenteditable', 'true');
        const inside = document.createElement('span');
        editable.appendChild(inside);
        root.append(other, area, editable);
        for (const target of [other, area, inside]) {
            if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) target.focus();
            const event = press(target);
            expect(event.defaultPrevented).toBe(false);
            expect(document.activeElement).not.toBe(searchInput(root));
        }
    });

    it('ignores other keys and modified /', () => {
        const root = mount(<SearchField label="Search" />);
        expect(press(document.body, 'a').defaultPrevented).toBe(false);
        const ctrl = new KeyboardEvent('keydown', { key: '/', ctrlKey: true, bubbles: true, cancelable: true });
        document.body.dispatchEvent(ctrl);
        expect(ctrl.defaultPrevented).toBe(false);
        expect(document.activeElement).not.toBe(searchInput(root));
    });

    it('removes its document listener on unmount', () => {
        mount(<SearchField label="Search" />);
        unmountAll();
        const event = press(document.body);
        expect(event.defaultPrevented).toBe(false);
    });
});

describe('isTypingTarget', () => {
    it('is true inside a field and false elsewhere', () => {
        const input = document.createElement('input');
        const select = document.createElement('select');
        const off = document.createElement('div');
        off.setAttribute('contenteditable', 'false');
        expect(isTypingTarget(input)).toBe(true);
        expect(isTypingTarget(select)).toBe(true);
        expect(isTypingTarget(off)).toBe(false);
        expect(isTypingTarget(document.body)).toBe(false);
        expect(isTypingTarget(null)).toBe(false);
    });
});
