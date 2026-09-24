/**
 * `FilterChips` — a filter bar on zero's `ToggleGroup`
 * (`docs/design/HANDOFF.md` → "Components"): a row of mono pill chips, one
 * value always chosen, each chip optionally carrying a count
 * (`QUEUED 3`). The chip look — 22 px mono pill, `line-strong` outline,
 * pressed = the primary at 15 % with a primary border — is the design
 * system's toggle-group patch, keyed on the root's `data-filter-chips`, so
 * no page draws a chip of its own.
 *
 * Single choice and never empty (`deselectable={false}`): pressing the
 * chosen chip keeps it. Arrow keys move between chips, Space / Enter
 * choose, and `aria-pressed` says which is on. Inside a form, `name` posts
 * the value through zero's hidden `<select>`.
 */
import { component, type Define } from '@sigx/runtime-core';
import { ToggleGroup } from '@sigx/zero';

export interface FilterChip {
    readonly value: string;
    readonly label: string;
    /** Shown after the label in the dim ink (`[data-chip-count]`); omitted = no count. */
    readonly count?: number | string;
    readonly disabled?: boolean;
}

export type FilterChipsProps =
    & Define.Model<string>
    & Define.Prop<'options', readonly FilterChip[], true>
    /** The group's accessible name (`Filter by status`). */
    & Define.Prop<'label', string, true>
    /** Posts the chosen value under this name, for a filter inside a form. */
    & Define.Prop<'name', string>
    & Define.Prop<'form', string>
    & Define.Prop<'disabled', boolean>
    & Define.Prop<'class', string>
    & Define.Event<'valueChange', string>;

export const FilterChips = component<FilterChipsProps>(({ props, emit }) => () => (
    <ToggleGroup.Root
        model={props.model}
        deselectable={false}
        onValueChange={(value: string) => emit('valueChange', value)}
        label={props.label}
        name={props.name}
        form={props.form}
        disabled={props.disabled}
        class={props.class}
        data-filter-chips=""
    >
        {props.options.map((option) => (
            <ToggleGroup.Item value={option.value} disabled={option.disabled}>
                {option.label}
                {option.count !== undefined ? <span data-chip-count="">{option.count}</span> : null}
            </ToggleGroup.Item>
        ))}
    </ToggleGroup.Root>
), { name: 'FilterChips' });
