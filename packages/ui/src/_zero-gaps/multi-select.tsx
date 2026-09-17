/**
 * Zero gap: a typed multi-select. `@sigx/zero`'s Combobox binds ONE string
 * (its hidden input posts one value), and no component holds a `string[]`
 * of picked options with per-item removal (andtii/zero-wip#479). This
 * composes the real Combobox for picking and renders the chosen values as
 * chips, each backed by a hidden input under the shared `name`, so the form
 * posts `name=a&name=b` pre-hydration exactly like a native `<select multiple>`.
 *
 * Anatomy (scope `ai-multi-select`): root / list / chip / chip-label /
 * chip-remove; the Combobox keeps its own scope inside the root.
 */

import { component, type Define } from '@sigx/runtime-core';
import { signal } from '@sigx/reactivity';
import { Combobox } from '@sigx/zero';

export interface MultiSelectOption {
    readonly value: string;
    readonly label?: string;
    readonly disabled?: boolean;
    readonly group?: string;
}

export type MultiSelectProps = Define.Model<string[]> &
    Define.Prop<'options', readonly MultiSelectOption[]> &
    /** Posted once per chosen value. */
    Define.Prop<'name', string, true> &
    Define.Prop<'placeholder', string> &
    /** Enter on text that matches no option adds it verbatim. */
    Define.Prop<'allowCustom', boolean> &
    Define.Prop<'disabled', boolean> &
    Define.Prop<'invalid', boolean> &
    Define.Prop<'emptyText', string> &
    Define.Event<'valueChange', string[]> &
    /** Extra content per chip (a per-item control such as a mode select). */
    Define.Slot<'chip', { value: string; label: string }>;

export const MultiSelect = component<MultiSelectProps>(
    ({ props, slots, emit }) => {
        const inert = signal({ values: [] as string[] });
        const local = signal({ query: '', pick: '' });

        const values = (): readonly string[] => (props.model ? props.model.value : inert.values);
        const set = (next: string[]) => {
            if (props.model) props.model.value = next;
            else inert.values = next;
            emit('valueChange', next);
        };
        const labelOf = (v: string) => props.options?.find((o) => o.value === v)?.label ?? v;
        const add = (raw: string) => {
            const v = raw.trim();
            if (v && !values().includes(v)) set([...values(), v]);
            // the combobox is a picker, never a holder: clear it for the next pick
            queueMicrotask(() => {
                local.pick = '';
                local.query = '';
            });
        };
        const remove = (v: string) => set(values().filter((x) => x !== v));
        const candidates = () => {
            const q = local.query.trim().toLowerCase();
            return (props.options ?? []).filter((o) => !values().includes(o.value) && (!q || (o.label ?? o.value).toLowerCase().includes(q) || o.value.toLowerCase().includes(q)));
        };
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== 'Enter' || e.defaultPrevented || !props.allowCustom || props.disabled) return;
            const q = local.query.trim();
            if (!q) return;
            e.preventDefault();
            add(q);
        };

        return () => {
            const picked = values();
            const items = candidates();
            return (
                <div data-scope="ai-multi-select" data-part="root" data-disabled={props.disabled ? '' : undefined} data-invalid={props.invalid ? '' : undefined} onKeyDown={onKeyDown}>
                    {picked.length ? (
                        <ul data-scope="ai-multi-select" data-part="list">
                            {picked.map((v) => (
                                <li data-scope="ai-multi-select" data-part="chip" key={v}>
                                    <span data-scope="ai-multi-select" data-part="chip-label">{labelOf(v)}</span>
                                    {slots.chip?.({ value: v, label: labelOf(v) })}
                                    <button type="button" data-scope="ai-multi-select" data-part="chip-remove" aria-label={`Remove ${labelOf(v)}`} disabled={props.disabled} onClick={() => remove(v)}>
                                        ×
                                    </button>
                                    <input type="hidden" name={props.name} value={v} disabled={props.disabled} />
                                </li>
                            ))}
                        </ul>
                    ) : null}
                    <Combobox.Root model={() => local.pick} model:inputValue={() => local.query} disabled={props.disabled} invalid={props.invalid} onValueChange={(v) => v && add(v)}>
                        <Combobox.Control>
                            <Combobox.Input placeholder={props.placeholder} />
                            <Combobox.Trigger />
                        </Combobox.Control>
                        <Combobox.Popup>
                            {items.map((o) => (
                                <Combobox.Item value={o.value} textValue={o.label} disabled={o.disabled} key={o.value}>
                                    {o.label ?? o.value}
                                </Combobox.Item>
                            ))}
                            {items.length === 0 ? <Combobox.Empty>{props.allowCustom ? 'Press Enter to add' : (props.emptyText ?? 'No matches')}</Combobox.Empty> : null}
                        </Combobox.Popup>
                    </Combobox.Root>
                </div>
            );
        };
    },
    { name: 'MultiSelect' }
);
