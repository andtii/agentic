import { describe, it, expect } from 'vitest';
import { expectAnatomy } from '@sigx/zero/testing';
import { Composer, NOBODY_HINT, aiComposerAnatomy } from '../src/composer';
import { mount, one, all, buttonNamed, tick } from './helpers';

const people = [
    { id: 'alice', label: 'Alice' },
    { id: 'albert', label: 'Albert' },
    { id: 'bob', label: 'Bob' }
];

function textarea(dom: ParentNode): HTMLTextAreaElement {
    return dom.querySelector('textarea')!;
}

/** Type into the box the way a user does: set the value, put the caret at its end, fire `input`. */
function type(dom: ParentNode, value: string): void {
    const ta = textarea(dom);
    ta.value = value;
    ta.setSelectionRange(value.length, value.length);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
}

function key(dom: ParentNode, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
    const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    textarea(dom).dispatchEvent(e);
    return e;
}

describe('the composer', () => {
    it('renders zero Textarea and Buttons inside its own anatomy', () => {
        const dom = mount(<Composer onSend={() => {}} />);
        expectAnatomy(dom, aiComposerAnatomy);
        expect(dom.querySelector('[data-scope="textarea"][data-part="textarea"]')).not.toBeNull();
        expect(dom.querySelector('[data-scope="button"][data-part="root"]')).not.toBeNull();
        expect(one(dom, 'ai-composer', 'mentions')!.hidden).toBe(true);
    });

    it('Enter sends the trimmed draft and clears the box; Shift+Enter does not', async () => {
        const sent: string[] = [];
        const dom = mount(<Composer onSend={(t) => sent.push(t)} />);
        type(dom, '  hello  ');
        const shift = key(dom, 'Enter', { shiftKey: true });
        expect(shift.defaultPrevented).toBe(false);
        expect(sent).toEqual([]);
        const enter = key(dom, 'Enter');
        expect(enter.defaultPrevented).toBe(true);
        expect(sent).toEqual(['hello']);
        await tick();
        expect(textarea(dom).value).toBe('');
    });

    it('the Send button submits the form, and an empty draft sends nothing', () => {
        const sent: string[] = [];
        const dom = mount(<Composer onSend={(t) => sent.push(t)} />);
        buttonNamed(dom, 'Send').click();
        expect(sent).toEqual([]);
        type(dom, 'go');
        dom.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        expect(sent).toEqual(['go']);
    });

    // The attribute, not `.rows`: happy-dom's reflection returns a string.
    it('grows with its lines, within bounds', async () => {
        const dom = mount(<Composer onSend={() => {}} maxRows={4} />);
        expect(textarea(dom).getAttribute('rows')).toBe('1');
        type(dom, 'a\nb\nc');
        await tick();
        expect(textarea(dom).getAttribute('rows')).toBe('3');
        type(dom, '1\n2\n3\n4\n5\n6');
        await tick();
        expect(textarea(dom).getAttribute('rows')).toBe('4');
    });

    it('during a turn, Send waits unless the agent steers, and Cancel appears only when it can cancel', () => {
        const busy = mount(<Composer onSend={() => {}} busy canCancel />);
        expect(buttonNamed(busy, 'Send').disabled).toBe(true);
        expect(buttonNamed(busy, 'Cancel')).toBeTruthy();
        const cancelled: number[] = [];
        const steering = mount(<Composer onSend={() => {}} onCancel={() => cancelled.push(1)} busy steers canCancel />);
        expect(buttonNamed(steering, 'Send').disabled).toBe(false);
        expect(textarea(steering).placeholder).toBe('Steer the running turn…');
        buttonNamed(steering, 'Cancel').click();
        expect(cancelled).toEqual([1]);
        const mute = mount(<Composer onSend={() => {}} busy />);
        expect([...mute.querySelectorAll('button')].some((b) => b.textContent === 'Cancel')).toBe(false);
    });

    it('lists the attachments it is given, with a Remove per item', () => {
        const removed: string[] = [];
        const dom = mount(<Composer onSend={() => {}} attachments={[{ id: 'f1', name: 'notes.md' }]} onRemoveAttachment={(id) => removed.push(id)} />);
        expect(all(dom, 'ai-composer', 'attachment').map((el) => el.textContent)).toEqual(['notes.mdRemove']);
        buttonNamed(dom, 'Remove').click();
        expect(removed).toEqual(['f1']);
        expectAnatomy(dom, aiComposerAnatomy);
    });

    describe('the addressing row', () => {
        it('shows who the message goes to as tile chips, with the hint the page gives right-aligned', () => {
            const dom = mount(<Composer onSend={() => {}} recipients={[{ id: 'atlas', name: 'Atlas', hue: 1, role: 'coordinator' }]} hint="Atlas answers unless you @ someone" />);
            const row = one(dom, 'ai-composer', 'addressing')!;
            expect(row.textContent!.startsWith('To')).toBe(true);
            const chips = all(dom, 'ai-composer', 'recipient');
            expect(chips.map((c) => c.textContent)).toEqual(['ATAtlascoordinator']);
            expect(chips[0]!.querySelector('[data-scope="ag-agent-tile"]')!.getAttribute('data-hue')).toBe('1');
            expect(one(dom, 'ai-composer', 'hint')!.textContent).toBe('Atlas answers unless you @ someone');
            expect(one(dom, 'ai-composer', 'hint')!.hasAttribute('data-nobody')).toBe(false);
            expectAnatomy(dom, aiComposerAnatomy);
        });

        it('says nobody will answer, dimmed, when the list is empty — and renders no row when the page gives none', () => {
            const nobody = mount(<Composer onSend={() => {}} recipients={[]} />);
            expect(all(nobody, 'ai-composer', 'recipient')).toHaveLength(0);
            expect(one(nobody, 'ai-composer', 'hint')!.textContent).toBe(NOBODY_HINT);
            expect(one(nobody, 'ai-composer', 'hint')!.hasAttribute('data-nobody')).toBe(true);
            expect(one(mount(<Composer onSend={() => {}} />), 'ai-composer', 'addressing')).toBeNull();
        });

        it('the action row: an attach icon button with a name, the key hint in mono, Send as the primary intent', () => {
            const attached: number[] = [];
            const dom = mount(<Composer onSend={() => {}} onAttach={() => attached.push(1)} />);
            const attach = dom.querySelector<HTMLButtonElement>('button[aria-label="Attach file"]')!;
            expect(attach.getAttribute('data-intent')).toBe('icon');
            attach.click();
            expect(attached).toEqual([1]);
            expect(one(dom, 'ai-composer', 'keys')!.textContent).toBe('Enter to send · Shift+Enter newline');
            expect(buttonNamed(dom, 'Send').getAttribute('data-intent')).toBe('primary');
            expect(buttonNamed(dom, 'Send').getAttribute('type')).toBe('submit');
        });
    });

    describe('@mentions', () => {
        it('opens on an @-token, filters as it is typed, and highlights the first match', async () => {
            const dom = mount(<Composer onSend={() => {}} mentions={people} />);
            type(dom, 'ask @al');
            await tick();
            const list = one(dom, 'ai-composer', 'mentions')!;
            expect(list.hidden).toBe(false);
            expect(list.getAttribute('data-state')).toBe('open');
            expect(all(dom, 'ai-composer', 'mention').map((el) => el.textContent)).toEqual(['Alice', 'Albert']);
            expect(all(dom, 'ai-composer', 'mention')[0]!.getAttribute('data-highlighted')).toBe('');
            expect(all(dom, 'ai-composer', 'mention')[1]!.hasAttribute('data-highlighted')).toBe(false);
            expectAnatomy(dom, aiComposerAnatomy);
        });

        it('wires the textarea to the popup as a combobox that tracks the highlighted option', async () => {
            const dom = mount(<Composer onSend={() => {}} mentions={people} />);
            await tick();
            const ta = textarea(dom);
            const list = one(dom, 'ai-composer', 'mentions')!;
            expect(ta.getAttribute('role')).toBe('combobox');
            expect(ta.getAttribute('aria-autocomplete')).toBe('list');
            expect(ta.getAttribute('aria-controls')).toBe(list.id);
            expect(ta.getAttribute('aria-expanded')).toBe('false');
            expect(ta.hasAttribute('aria-activedescendant')).toBe(false);

            type(dom, '@al');
            await tick();
            const options = all(dom, 'ai-composer', 'mention');
            expect(options.every((o) => o.id !== '')).toBe(true);
            expect(new Set(options.map((o) => o.id)).size).toBe(options.length);
            expect(ta.getAttribute('aria-expanded')).toBe('true');
            expect(ta.getAttribute('aria-activedescendant')).toBe(options[0]!.id);

            const albert = options[1]!.id;
            key(dom, 'ArrowDown');
            await tick();
            expect(ta.getAttribute('aria-activedescendant')).toBe(albert);
            // The id follows the mention, not its position in the filtered list.
            type(dom, '@alb');
            await tick();
            expect(all(dom, 'ai-composer', 'mention')[0]!.id).toBe(albert);

            key(dom, 'Escape');
            await tick();
            expect(ta.getAttribute('aria-expanded')).toBe('false');
            expect(ta.hasAttribute('aria-activedescendant')).toBe(false);
        });

        it('arrows move the highlight and Enter picks — into the draft, not into a send', async () => {
            const sent: string[] = [];
            const dom = mount(<Composer onSend={(t) => sent.push(t)} mentions={people} />);
            type(dom, '@al');
            await tick();
            key(dom, 'ArrowDown');
            await tick();
            expect(all(dom, 'ai-composer', 'mention')[1]!.getAttribute('data-highlighted')).toBe('');
            key(dom, 'Enter');
            await tick();
            expect(sent).toEqual([]);
            expect(textarea(dom).value).toBe('@Albert ');
            expect(one(dom, 'ai-composer', 'mentions')!.hidden).toBe(true);
        });

        it('a click picks, Escape dismisses, and a space ends the token', async () => {
            const dom = mount(<Composer onSend={() => {}} mentions={people} />);
            type(dom, 'hi @b');
            await tick();
            all(dom, 'ai-composer', 'mention')[0]!.click();
            await tick();
            expect(textarea(dom).value).toBe('hi @Bob ');
            type(dom, 'hi @Bob @a');
            await tick();
            expect(one(dom, 'ai-composer', 'mentions')!.hidden).toBe(false);
            key(dom, 'Escape');
            await tick();
            expect(one(dom, 'ai-composer', 'mentions')!.hidden).toBe(true);
            type(dom, 'hi @Bob @a ');
            await tick();
            expect(one(dom, 'ai-composer', 'mentions')!.hidden).toBe(true);
        });
    });
});
