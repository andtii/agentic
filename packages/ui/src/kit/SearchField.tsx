/**
 * `SearchField` — a page's search box (`docs/design/plugins/HANDOFF-plugins.md`
 * → "All plugins", board `Plugins`): a `role="search"` landmark over zero's
 * `Input` (`type="search"`), its label visually hidden, a search icon before
 * and a `/` hint chip (zero's `Kbd`) after. `/` anywhere on the page focuses
 * it, unless the keystroke is typing into another field.
 */
import { component, onMounted, onUnmounted, type Define } from '@sigx/runtime-core';
import { Input, Kbd } from '@sigx/zero';
import { Icon } from './icons.js';

export type SearchFieldProps =
    & Define.Model<string>
    /** The accessible name, on a visually hidden `<label>`. */
    & Define.Prop<'label', string, true>
    & Define.Prop<'placeholder', string>
    & Define.Prop<'class', string>
    & Define.Event<'valueChange', string>;

/** Whether a keystroke aimed at `target` is typing into a field, so `/` is text there, not the shortcut. */
export function isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    if (target instanceof HTMLElement && target.isContentEditable) return true;
    return target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !== null;
}

// zero's parts forward no `style`: the field chrome (38 px, `line-strong`, base-100) is the input
// recipe's; the box (440 px on board `Plugins`) and the icon sit on the component's own elements.
const boxStyle = 'display: flex; flex-direction: column; inline-size: min(440px, 100%)';
const iconStyle = 'display: flex; align-items: center; padding-inline-start: var(--space-md); color: var(--ag-text-dim)';
const hintStyle = 'display: flex; align-items: center; padding-inline-end: var(--space-sm)';

export const SearchField = component<SearchFieldProps>(({ props, emit }) => {
    let root: HTMLElement | null = null;
    const onKey = (e: KeyboardEvent): void => {
        if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
        if (isTypingTarget(e.target)) return;
        const input = root?.querySelector<HTMLInputElement>('input');
        if (!input) return;
        e.preventDefault();
        input.focus();
    };
    onMounted(() => document.addEventListener('keydown', onKey));
    onUnmounted(() => document.removeEventListener('keydown', onKey));
    return () => (
        <div role="search" data-search-field="" class={props.class} style={boxStyle} ref={(el: HTMLElement) => { root = el; }}>
            <Input.Root model={props.model} type="search" autocomplete="off" onValueChange={(v: string) => emit('valueChange', v)}>
                <Input.Label visuallyHidden>{props.label}</Input.Label>
                <Input.Control>
                    <span style={iconStyle}><Icon name="search" size={15} /></span>
                    <Input.Input placeholder={props.placeholder} aria-keyshortcuts="/" />
                    <span style={hintStyle}><Kbd.Root aria-hidden="true">/</Kbd.Root></span>
                </Input.Control>
            </Input.Root>
        </div>
    );
}, { name: 'SearchField' });
