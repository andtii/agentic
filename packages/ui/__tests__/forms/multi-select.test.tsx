import { signal } from '@sigx/reactivity';
import { MultiSelect } from '@agentic/ui';
import { mount, setText } from './helpers';

const options = [
    { value: 'read', label: 'Read' },
    { value: 'bash', label: 'Bash' },
    { value: 'write', label: 'Write' }
];

function mountIn(values: string[], props: { allowCustom?: boolean; disabled?: boolean } = {}) {
    const state = signal({ values });
    const changes: string[][] = [];
    const form = document.createElement('form');
    document.body.appendChild(form);
    const root = mount(<MultiSelect model={() => state.values} name="tools" options={options} allowCustom={props.allowCustom} disabled={props.disabled} onValueChange={(v) => changes.push(v)} />);
    form.appendChild(root);
    const input = () => root.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    const items = () => [...root.querySelectorAll<HTMLElement>('[data-scope="combobox"][data-part="item"]')];
    const chips = () => [...root.querySelectorAll<HTMLElement>('[data-part="chip"]')];
    const posted = () => new FormData(form).getAll('tools');
    return { state, root, form, input, items, chips, posted, changes };
}

describe('MultiSelect (zero gap)', () => {
    it('renders a chip and a hidden input per value, and offers only the rest', () => {
        const { chips, posted, items } = mountIn(['read']);
        expect(chips().map((c) => c.querySelector('[data-part="chip-label"]')!.textContent)).toEqual(['Read']);
        expect(posted()).toEqual(['read']);
        expect(items().map((i) => i.textContent)).toEqual(['Bash', 'Write']);
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

    it('clears the picker after a pick so the next one starts empty', async () => {
        const { input, items, state } = mountIn([]);
        items()[0]!.click();
        await Promise.resolve();
        await Promise.resolve();
        expect(state.values).toEqual(['read']);
        expect(input().value).toBe('');
        expect(items().map((i) => i.textContent)).toEqual(['Bash', 'Write']);
    });

    it('the remove button is labelled and removes its value', () => {
        const { chips, state, posted } = mountIn(['read', 'bash']);
        const remove = chips()[0]!.querySelector<HTMLButtonElement>('[data-part="chip-remove"]')!;
        expect(remove.getAttribute('aria-label')).toBe('Remove Read');
        remove.click();
        expect(state.values).toEqual(['bash']);
        expect(posted()).toEqual(['bash']);
    });

    it('Enter adds free text only when allowCustom', () => {
        const custom = mountIn([], { allowCustom: true });
        setText(custom.input(), 'my-tool');
        expect(custom.root.querySelector('[data-part="empty"]')!.textContent).toMatch(/Enter/);
        custom.input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        expect(custom.state.values).toEqual(['my-tool']);

        const strict = mountIn([]);
        setText(strict.input(), 'my-tool');
        strict.input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        expect(strict.state.values).toEqual([]);
    });

    it('ignores duplicates and blanks', () => {
        const { state, input } = mountIn(['read'], { allowCustom: true });
        setText(input(), ' read ');
        input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        setText(input(), '   ');
        input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        expect(state.values).toEqual(['read']);
    });

    it('disabled posts nothing and removes nothing', () => {
        const { posted, chips, state } = mountIn(['read'], { disabled: true });
        expect(posted()).toEqual([]);
        chips()[0]!.querySelector<HTMLButtonElement>('[data-part="chip-remove"]')!.click();
        expect(state.values).toEqual(['read']);
    });

    it('works uncontrolled', () => {
        const root = mount(<MultiSelect name="x" options={options} />);
        root.querySelector<HTMLElement>('[data-scope="combobox"][data-part="item"]')!.click();
        expect(root.querySelectorAll('input[type="hidden"][name="x"]').length).toBe(1);
    });
});
