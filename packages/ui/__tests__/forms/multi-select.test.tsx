import { signal } from '@sigx/reactivity';
import { MultiSelect } from '@agentic/ui';
import { mount, setText } from './helpers';

const options = [
    { value: 'read', label: 'Read' },
    { value: 'bash', label: 'Bash' },
    { value: 'write', label: 'Write' }
];

function mountIn(values: string[], props: { allowCustom?: boolean; disabled?: boolean; tag?: boolean } = {}) {
    const state = signal({ values });
    const changes: string[][] = [];
    const form = document.createElement('form');
    document.body.appendChild(form);
    const tag = props.tag ? { tag: ({ value }: { value: string }) => <button type="button" data-extra={value}>mode</button> } : {};
    const root = mount(<MultiSelect model={() => state.values} name="tools" options={options} allowCustom={props.allowCustom} disabled={props.disabled} onValueChange={(v) => changes.push(v)} slots={tag} />);
    form.appendChild(root);
    const input = () => root.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    const items = () => [...root.querySelectorAll<HTMLElement>('[data-scope="combobox"][data-part="item"]')];
    const tags = () => [...root.querySelectorAll<HTMLElement>('[data-scope="combobox"][data-part="tag"]')];
    const label = (t: HTMLElement) => t.querySelector('[data-part="tag-label"]')!.textContent;
    const remove = (t: HTMLElement) => t.querySelector<HTMLElement>('[data-part="tag-remove"]')!;
    const posted = () => new FormData(form).getAll('tools');
    const enter = () => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return { state, root, form, input, items, tags, label, remove, posted, enter, changes };
}

describe('MultiSelect (zero Combobox multiple)', () => {
    it('renders a tag per value and posts each under the name, pre-hydration shape', () => {
        const { tags, label, posted } = mountIn(['read', 'write']);
        expect(tags().map(label)).toEqual(['Read', 'Write']);
        expect(posted()).toEqual(['read', 'write']);
    });

    it('typing narrows and picking adds through the model', () => {
        const { state, input, items, posted, changes } = mountIn(['read']);
        setText(input(), 'wr');
        expect(items().map((i) => i.textContent)).toEqual(['Write']);
        items()[0]!.click();
        expect(state.values).toEqual(['read', 'write']);
        expect(posted()).toEqual(['read', 'write']);
        expect(changes.at(-1)).toEqual(['read', 'write']);
    });

    it('the remove button is labelled and removes its value', () => {
        const { tags, remove, state, posted } = mountIn(['read', 'bash']);
        expect(remove(tags()[0]!).getAttribute('aria-label')).toBe('Remove Read');
        remove(tags()[0]!).click();
        expect(state.values).toEqual(['bash']);
        expect(posted()).toEqual(['bash']);
    });

    it('Enter adds free text only when allowCustom, and the custom value posts', () => {
        const custom = mountIn([], { allowCustom: true });
        setText(custom.input(), 'my-tool');
        expect(custom.root.querySelector('[data-part="empty"]')!.textContent).toMatch(/Enter/);
        custom.enter();
        expect(custom.state.values).toEqual(['my-tool']);
        expect(custom.posted()).toEqual(['my-tool']);
        expect(custom.tags().map(custom.label)).toEqual(['my-tool']);

        const strict = mountIn([]);
        setText(strict.input(), 'my-tool');
        strict.enter();
        expect(strict.state.values).toEqual([]);
    });

    it('free text naming an option picks the option, never a duplicate', () => {
        const { state, input, enter } = mountIn(['read'], { allowCustom: true });
        setText(input(), 'Bash');
        enter();
        expect(state.values).toEqual(['read', 'bash']);
        setText(input(), 'Bash');
        enter();
        expect(state.values.filter((v) => v === 'bash')).toHaveLength(1);
    });

    it('the tag slot sits between the label and the remove button of every tag', () => {
        const { tags } = mountIn(['read', 'bash'], { tag: true });
        const layout = tags().map((t) => [...t.children].map((c) => c.getAttribute('data-part') ?? `extra:${c.getAttribute('data-extra')}`));
        expect(layout).toEqual([
            ['tag-label', 'extra:read', 'tag-remove'],
            ['tag-label', 'extra:bash', 'tag-remove']
        ]);
    });

    it('a key pressed on a control inside a tag stays with that control', () => {
        const { tags, state } = mountIn(['read', 'bash'], { tag: true });
        const extra = tags()[1]!.querySelector<HTMLElement>('[data-extra]')!;
        for (const key of ['Backspace', 'Enter', 'ArrowDown', ' ']) extra.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        expect(state.values).toEqual(['read', 'bash']);
    });

    it('disabled posts nothing and removes nothing', () => {
        const { posted, tags, remove, state } = mountIn(['read'], { disabled: true });
        expect(posted()).toEqual([]);
        remove(tags()[0]!).click();
        expect(state.values).toEqual(['read']);
    });

    it('works uncontrolled', () => {
        const form = document.createElement('form');
        document.body.appendChild(form);
        const root = mount(<MultiSelect name="x" options={options} />);
        form.appendChild(root);
        root.querySelector<HTMLElement>('[data-scope="combobox"][data-part="item"]')!.click();
        expect(new FormData(form).getAll('x')).toEqual(['read']);
    });
});
