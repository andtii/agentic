/**
 * Labelled fields. Each wraps one zero control in `Field.Root` with a
 * `Field.Label`, an optional `Field.Description` and a `Field.Error` that is
 * rendered only while there is an error (its `role="alert"` then announces
 * it), so every field a form renders has a label and an accessible error by
 * construction. The control keeps its `name`, so it posts pre-hydration.
 */

import { component, type Define } from '@sigx/runtime-core';
import { Field, Input, NumberInput, Select, Switch, Textarea, type InputType } from '@sigx/zero';
import { derivedModel } from '@sigx/zero/behaviors';
import { MultiSelect, type MultiSelectOption } from '../_zero-gaps/multi-select.js';
import { agMapFieldAnatomy } from '../kit/anatomy.js';
import { Button } from '../kit/Button.js';
import type { MapRow } from './schema-model.js';

export type FieldOption = MultiSelectOption;

type Common = Define.Prop<'name', string, true> &
    Define.Prop<'label', string, true> &
    Define.Prop<'description', string> &
    /** The message to show; also marks the field invalid. */
    Define.Prop<'error', string> &
    Define.Prop<'required', boolean> &
    Define.Prop<'disabled', boolean>;

export type TextFieldProps = Define.Model<string> & Common & Define.Prop<'placeholder', string> & Define.Prop<'type', InputType> & Define.Prop<'maxlength', number>;

export const TextField = component<TextFieldProps>(
    ({ props }) =>
        () => (
            <Field.Root invalid={!!props.error} required={props.required} disabled={props.disabled}>
                <Field.Label>{props.label}</Field.Label>
                <Input.Root model={props.model} name={props.name} type={props.type} required={props.required} maxlength={props.maxlength}>
                    <Input.Control>
                        <Input.Input placeholder={props.placeholder} />
                    </Input.Control>
                </Input.Root>
                {props.description ? <Field.Description>{props.description}</Field.Description> : null}
                {props.error ? <Field.Error>{props.error}</Field.Error> : null}
            </Field.Root>
        ),
    { name: 'TextField' }
);

export type TextareaFieldProps = Define.Model<string> & Common & Define.Prop<'placeholder', string> & Define.Prop<'rows', number>;

export const TextareaField = component<TextareaFieldProps>(
    ({ props }) =>
        () => (
            <Field.Root invalid={!!props.error} required={props.required} disabled={props.disabled}>
                <Field.Label>{props.label}</Field.Label>
                <Textarea.Root model={props.model} name={props.name} required={props.required} rows={props.rows}>
                    <Textarea.Textarea placeholder={props.placeholder} />
                </Textarea.Root>
                {props.description ? <Field.Description>{props.description}</Field.Description> : null}
                {props.error ? <Field.Error>{props.error}</Field.Error> : null}
            </Field.Root>
        ),
    { name: 'TextareaField' }
);

export type SelectFieldProps = Define.Model<string> &
    Common &
    Define.Prop<'options', readonly FieldOption[], true> &
    /** Shown while nothing is chosen; a model of `''` is nothing chosen and posts nothing. */
    Define.Prop<'placeholder', string>;

/**
 * zero's `Select.Root` over the options as data. Its value model is
 * `string | null` and reserves `''` for the placeholder; this field keeps the
 * string model its callers bind (`''` = nothing chosen) by bridging the two,
 * and an option valued `''` (a caller's "No project") becomes the placeholder
 * text rather than an item. The hidden `<select name>` posts pre-hydration.
 */
export const SelectField = component<SelectFieldProps>(({ props }) => {
    const model = derivedModel<string | null>(
        () => props.model?.value || null,
        (next) => {
            if (props.model) props.model.value = next ?? '';
        }
    );
    const items = (): readonly FieldOption[] => props.options.filter((o) => o.value !== '');
    const placeholder = (): string | undefined => props.placeholder ?? props.options.find((o) => o.value === '')?.label;
    return () => (
        <Field.Root invalid={!!props.error} required={props.required} disabled={props.disabled}>
            <Field.Label>{props.label}</Field.Label>
            <Select.Root
                model={model}
                items={items()}
                itemValue={(o) => o.value}
                itemLabel={(o) => o.label ?? o.value}
                itemDisabled={(o) => !!o.disabled}
                name={props.name}
                placeholder={placeholder()}
                required={props.required}
            />
            {props.description ? <Field.Description>{props.description}</Field.Description> : null}
            {props.error ? <Field.Error>{props.error}</Field.Error> : null}
        </Field.Root>
    );
}, { name: 'SelectField' });

export type NumberFieldProps = Define.Model<number | null> & Common & Define.Prop<'min', number> & Define.Prop<'max', number> & Define.Prop<'step', number> & Define.Prop<'placeholder', string>;

export const NumberField = component<NumberFieldProps>(
    ({ props }) =>
        () => (
            <Field.Root invalid={!!props.error} required={props.required} disabled={props.disabled}>
                <Field.Label>{props.label}</Field.Label>
                <NumberInput.Root model={props.model} name={props.name} min={props.min} max={props.max} step={props.step} required={props.required}>
                    <NumberInput.Control>
                        <NumberInput.Input placeholder={props.placeholder} />
                    </NumberInput.Control>
                </NumberInput.Root>
                {props.description ? <Field.Description>{props.description}</Field.Description> : null}
                {props.error ? <Field.Error>{props.error}</Field.Error> : null}
            </Field.Root>
        ),
    { name: 'NumberField' }
);

export type SwitchFieldProps = Define.Model<boolean> & Common;

/** The switch's own `label` part carries the text (a second `Field.Label` would double the name). */
export const SwitchField = component<SwitchFieldProps>(
    ({ props }) =>
        () => (
            <Field.Root invalid={!!props.error} required={props.required} disabled={props.disabled}>
                <Switch.Root model={props.model} name={props.name} required={props.required}>
                    {props.label}
                </Switch.Root>
                {props.description ? <Field.Description>{props.description}</Field.Description> : null}
                {props.error ? <Field.Error>{props.error}</Field.Error> : null}
            </Field.Root>
        ),
    { name: 'SwitchField' }
);

export type MultiSelectFieldProps = Define.Model<string[]> &
    Common &
    Define.Prop<'options', readonly FieldOption[]> &
    Define.Prop<'placeholder', string> &
    Define.Prop<'allowCustom', boolean> &
    Define.Slot<'chip', { value: string; label: string }>;

export const MultiSelectField = component<MultiSelectFieldProps>(
    ({ props, slots }) =>
        () => (
            <Field.Root invalid={!!props.error} required={props.required} disabled={props.disabled}>
                <Field.Label>{props.label}</Field.Label>
                <MultiSelect model={props.model} name={props.name} options={props.options} placeholder={props.placeholder} allowCustom={props.allowCustom} disabled={props.disabled} invalid={!!props.error} slots={{ chip: slots.chip }} />
                {props.description ? <Field.Description>{props.description}</Field.Description> : null}
                {props.error ? <Field.Error>{props.error}</Field.Error> : null}
            </Field.Root>
        ),
    { name: 'MultiSelectField' }
);

export type MapFieldProps = Define.Model<MapRow[]> &
    Common &
    Define.Prop<'keyPlaceholder', string> &
    Define.Prop<'valuePlaceholder', string> &
    Define.Prop<'addLabel', string>;

const MAP = agMapFieldAnatomy.scope;

/**
 * A string → string map (headers, process environment) as name / value rows.
 * The model is the ROWS, not the record: a half-typed or repeated name keeps
 * its row until the form reads the map back (`fromSchemaDraft`). Each input is
 * zero's `input` anatomy drawn directly, because a row's inputs are named by
 * `aria-label` and `Input.Input` takes none; they post as `<name>.key` /
 * `<name>.value` pairs.
 */
export const MapField = component<MapFieldProps>(
    ({ props }) => {
        const rows = (): MapRow[] => props.model?.value ?? [];
        const set = (next: MapRow[]) => {
            if (props.model) props.model.value = next;
        };
        const cell = (row: MapRow, index: number, part: 'key' | 'value') => (
            <div data-scope="input" data-part="root" data-invalid={props.error ? '' : undefined}>
                <div data-scope="input" data-part="control" data-invalid={props.error ? '' : undefined}>
                    <input
                        data-scope="input"
                        data-part="input"
                        type="text"
                        name={`${props.name}.${part}`}
                        aria-label={`${props.label} ${part === 'key' ? 'name' : 'value'} ${index + 1}`}
                        aria-invalid={props.error ? 'true' : undefined}
                        autoComplete="off"
                        value={row[part]}
                        placeholder={part === 'key' ? (props.keyPlaceholder ?? 'Name') : (props.valuePlaceholder ?? 'Value')}
                        disabled={props.disabled}
                        onInput={(e: Event) => {
                            row[part] = (e.target as HTMLInputElement).value;
                        }}
                    />
                </div>
            </div>
        );
        return () => (
            <Field.Root invalid={!!props.error} required={props.required} disabled={props.disabled}>
                <Field.Label>{props.label}</Field.Label>
                <div data-scope={MAP} data-part="root" role="group" aria-label={props.label}>
                    {rows().map((row, i) => (
                        <div data-scope={MAP} data-part="row" key={i}>
                            {cell(row, i, 'key')}
                            {cell(row, i, 'value')}
                            <Button intent="icon" icon="close" label={`Remove ${props.label} row ${i + 1}`} disabled={props.disabled} onClick={() => set(rows().filter((_, j) => j !== i))} />
                        </div>
                    ))}
                    <div data-scope={MAP} data-part="actions">
                        <Button icon="plus" disabled={props.disabled} onClick={() => set([...rows(), { key: '', value: '' }])}>
                            {props.addLabel ?? 'Add row'}
                        </Button>
                    </div>
                </div>
                {props.description ? <Field.Description>{props.description}</Field.Description> : null}
                {props.error ? <Field.Error>{props.error}</Field.Error> : null}
            </Field.Root>
        );
    },
    { name: 'MapField' }
);
