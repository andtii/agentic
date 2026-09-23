import { describe, it, expect } from 'vitest';
import { expectAnatomy } from '@sigx/zero/testing';
import { signal } from '@sigx/reactivity';
import { component } from '@sigx/runtime-core';
import { Composer, NOBODY_HINT, aiComposerAnatomy, appendToDraft, type ComposerInsert } from '../src/composer';
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

    it('lists the attachments it is given, with a named Remove per item', () => {
        const removed: string[] = [];
        const dom = mount(<Composer onSend={() => {}} attachments={[{ id: 'f1', name: 'notes.md' }]} onRemoveAttachment={(id) => removed.push(id)} />);
        expect(all(dom, 'ai-composer', 'attachment').map((el) => el.textContent)).toEqual(['notes.md']);
        buttonNamed(dom, 'Remove notes.md').click();
        expect(removed).toEqual(['f1']);
        expectAnatomy(dom, aiComposerAnatomy);
    });

    describe('attachments', () => {
        const png = (name = 'shot.png'): File => new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });

        /** A `DataTransfer`-shaped carrier — happy-dom's clipboard / drag events carry no real transfer. */
        function transfer(files: File[], types: string[] = files.length ? ['Files'] : []): DataTransfer {
            return { files, types, dropEffect: 'none' } as unknown as DataTransfer;
        }

        function fire(target: EventTarget, type: string, field: 'clipboardData' | 'dataTransfer', data: DataTransfer): Event {
            const e = new Event(type, { bubbles: true, cancelable: true });
            Object.defineProperty(e, field, { value: data });
            target.dispatchEvent(e);
            return e;
        }

        it('a paste carrying files emits them as `files`, and a text paste passes through untouched', () => {
            const got: File[][] = [];
            const dom = mount(<Composer onSend={() => {}} onFiles={(f) => got.push(f)} />);
            const file = png();
            const paste = fire(textarea(dom), 'paste', 'clipboardData', transfer([file]));
            expect(got).toEqual([[file]]);
            expect(paste.defaultPrevented).toBe(true);
            const text = fire(textarea(dom), 'paste', 'clipboardData', transfer([], ['text/plain']));
            expect(got).toHaveLength(1);
            expect(text.defaultPrevented).toBe(false);
        });

        it('a drop emits `files`, and the card is highlighted while the drag hovers', async () => {
            const got: File[][] = [];
            const dom = mount(<Composer onSend={() => {}} onFiles={(f) => got.push(f)} />);
            const root = one(dom, 'ai-composer', 'root')!;
            const files = [png('a.png'), png('b.png')];
            expect(fire(textarea(dom), 'dragenter', 'dataTransfer', transfer(files)).defaultPrevented).toBe(true);
            expect(fire(textarea(dom), 'dragover', 'dataTransfer', transfer(files)).defaultPrevented).toBe(true);
            await tick();
            expect(root.hasAttribute('data-highlighted')).toBe(true);
            expectAnatomy(dom, aiComposerAnatomy);
            fire(textarea(dom), 'drop', 'dataTransfer', transfer(files));
            await tick();
            expect(got).toEqual([files]);
            expect(root.hasAttribute('data-highlighted')).toBe(false);
        });

        it('a drag leaving the card clears the highlight, and a drag of text is not a drop target', async () => {
            const dom = mount(<Composer onSend={() => {}} />);
            const root = one(dom, 'ai-composer', 'root')!;
            fire(root, 'dragenter', 'dataTransfer', transfer([png()]));
            await tick();
            expect(root.hasAttribute('data-highlighted')).toBe(true);
            root.dispatchEvent(new Event('dragleave', { bubbles: true }));
            await tick();
            expect(root.hasAttribute('data-highlighted')).toBe(false);
            expect(fire(root, 'dragover', 'dataTransfer', transfer([], ['text/plain'])).defaultPrevented).toBe(false);
        });

        it('Attach opens the hidden multi-file picker, and a pick emits `files`', () => {
            const got: File[][] = [];
            const attached: number[] = [];
            const dom = mount(<Composer onSend={() => {}} onFiles={(f) => got.push(f)} onAttach={() => attached.push(1)} accept="image/*" />);
            const input = dom.querySelector<HTMLInputElement>('input[type="file"]')!;
            expect(input.multiple).toBe(true);
            expect(input.hidden).toBe(true);
            expect(input.getAttribute('accept')).toBe('image/*');
            let opened = 0;
            input.click = () => {
                opened++;
            };
            buttonNamed(dom, 'Attach file').click();
            expect(opened).toBe(1);
            expect(attached).toEqual([1]);
            const file = png();
            Object.defineProperty(input, 'files', { value: [file], configurable: true });
            input.dispatchEvent(new Event('change', { bubbles: true }));
            expect(got).toEqual([[file]]);
        });

        it('a disabled composer takes no files', () => {
            const got: File[][] = [];
            const dom = mount(<Composer onSend={() => {}} onFiles={(f) => got.push(f)} disabled />);
            fire(textarea(dom), 'paste', 'clipboardData', transfer([png()]));
            fire(textarea(dom), 'drop', 'dataTransfer', transfer([png()]));
            expect(got).toEqual([]);
        });

        it('chips render each status: thumbnail, size, spinner while uploading, the error line', () => {
            const dom = mount(
                <Composer
                    onSend={() => {}}
                    attachments={[
                        { id: 'a', name: 'shot.png', size: 1536, status: 'uploading', previewUrl: 'blob:shot' },
                        { id: 'b', name: 'notes.md', status: 'ready' },
                        { id: 'c', name: 'big.pdf', status: 'error', error: 'Too large' }
                    ]}
                />
            );
            const chips = all(dom, 'ai-composer', 'attachment');
            expect(chips.map((c) => c.getAttribute('data-state'))).toEqual(['loading', 'complete', 'error']);
            expect(chips[0]!.querySelector('img')!.getAttribute('src')).toBe('blob:shot');
            expect(one(chips[0]!, 'ai-composer', 'attachment-size')!.textContent).toBe('1.5 kB');
            expect(one(chips[0]!, 'ai-composer', 'spinner')!.getAttribute('aria-label')).toBe('Uploading shot.png');
            expect(chips[0]!.getAttribute('aria-busy')).toBe('true');
            expect(chips[1]!.querySelector('img')).toBeNull();
            expect(chips[1]!.querySelector('[data-icon="file"]')).not.toBeNull();
            expect(one(chips[1]!, 'ai-composer', 'spinner')).toBeNull();
            expect(one(chips[2]!, 'ai-composer', 'attachment-error')!.textContent).toBe('Too large');
            expectAnatomy(dom, aiComposerAnatomy);
        });

        it('Send waits while any chip is uploading', () => {
            const sent: string[] = [];
            const dom = mount(<Composer onSend={(t) => sent.push(t)} attachments={[{ id: 'a', name: 'a.png', status: 'uploading' }]} />);
            expect(buttonNamed(dom, 'Send').disabled).toBe(true);
            type(dom, 'look');
            key(dom, 'Enter');
            expect(sent).toEqual([]);
        });

        it('Send goes with attachments and an empty draft', () => {
            const sent: string[] = [];
            const dom = mount(<Composer onSend={(t) => sent.push(t)} attachments={[{ id: 'a', name: 'a.png', status: 'ready' }]} />);
            expect(buttonNamed(dom, 'Send').disabled).toBe(false);
            dom.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            expect(sent).toEqual(['']);
        });
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

describe('a host inserting into the draft (#565)', () => {
    it('appends spaced text', () => {
        expect(appendToDraft('', '@file:a.ts ')).toBe('@file:a.ts ');
        expect(appendToDraft('look at', '@file:a.ts ')).toBe('look at @file:a.ts ');
        expect(appendToDraft('look at ', '@file:a.ts ')).toBe('look at @file:a.ts ');
        expect(appendToDraft('keep', '')).toBe('keep');
    });

    it('puts the insert in on mount and again on each new id, reporting the draft', async () => {
        const st = signal<{ insert: ComposerInsert }>({ insert: { id: 1, text: '@file:src/a.ts ' } });
        const drafts: string[] = [];
        const sent: string[] = [];
        const Host = component(() => () => <Composer insert={st.insert} onDraft={(d: string) => drafts.push(d)} onSend={(t: string) => sent.push(t)} />);
        const dom = mount(<Host />);
        await tick();
        expect(textarea(dom).value).toBe('@file:src/a.ts ');
        type(dom, '@file:src/a.ts why?');
        st.insert = { id: 2, text: '@file:src/b.ts ' };
        await tick();
        expect(textarea(dom).value).toBe('@file:src/a.ts why? @file:src/b.ts ');
        expect(drafts).toEqual(['@file:src/a.ts ', '@file:src/a.ts why? @file:src/b.ts ']);
        // The same id again inserts nothing; the draft sends as typed.
        st.insert = { id: 2, text: '@file:src/b.ts ' };
        await tick();
        key(dom, 'Enter');
        expect(sent).toEqual(['@file:src/a.ts why? @file:src/b.ts']);
    });
});
