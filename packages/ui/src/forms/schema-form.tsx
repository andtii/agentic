/**
 * `SchemaForm` — a plugin's config form, drawn from its `ConfigSchema`
 * (core's typed JSON-Schema subset, PLG-02). One labelled field per
 * property: string → text (`uri` → a URL input), `enum` → select, number /
 * integer → number, boolean → switch, string list → chips, string map →
 * name / value rows. Validation is core's `validateConfig`, so the form and
 * the Registry refuse the same things.
 *
 * `value` is the stored config; `submit` hands back a sparse config
 * (`schema-model.ts`) and the caller writes it. While the draft is clean a
 * changed `value` (a live read) is taken up; an edited draft is never
 * overwritten. `change` hands back the same sparse config on every edit, and
 * `load` replaces the draft (a preset, #621) — the caller decides what goes in.
 * Secrets are not config — `SecretField` takes those.
 */

import { component, type Define } from '@sigx/runtime-core';
import { batch, computed, signal, watch } from '@sigx/reactivity';
import type { ConfigNumberProperty, ConfigSchema, ConfigStringArrayProperty, ConfigStringProperty } from '@agentic/core';
import { Button } from '../kit/Button.js';
import { ErrorNote } from '../kit/ErrorNote.js';
import { MapField, MultiSelectField, NumberField, SelectField, SwitchField, TextField } from './fields.js';
import { fromSchemaDraft, schemaFields, toSchemaDraft, validateSchemaDraft, type SchemaDraft, type SchemaErrors, type SchemaField } from './schema-model.js';

export interface SchemaFormApi {
    reset(): void;
    submit(): boolean;
    errors(): SchemaErrors;
    dirty(): boolean;
    readonly draft: SchemaDraft;
    /** The draft as a sparse config, as `submit` would hand it back — without validating. */
    value(): Record<string, unknown>;
    /** Replace the draft with `config` (a preset laid over `value()`, say); the stored `value` it was opened on is kept. */
    load(config: Readonly<Record<string, unknown>>): void;
}

export type SchemaFormProps = Define.Prop<'schema', ConfigSchema, true> &
    /** The stored config (sparse is fine: defaults show through). */
    Define.Prop<'value', Readonly<Record<string, unknown>>> &
    /** Prefixes every control's `name`, so two forms on a page do not collide. */
    Define.Prop<'name', string> &
    Define.Prop<'action', string> &
    Define.Prop<'method', 'post' | 'get'> &
    Define.Prop<'submitLabel', string> &
    Define.Prop<'disabled', boolean> &
    /** The write is in flight: the save button spins and the fields hold still. */
    Define.Prop<'saving', boolean> &
    /** What the write answered when it refused (`bad-config`), shown above the actions. */
    Define.Prop<'error', string> &
    /** Leave the buttons to the caller (a save rail driving `submit()` through the ref). */
    Define.Prop<'hideActions', boolean> &
    Define.Event<'submit', Record<string, unknown>> &
    Define.Event<'invalid', SchemaErrors> &
    /** The draft as a sparse config, on every edit (and on `load`). */
    Define.Event<'change', Record<string, unknown>> &
    Define.Expose<SchemaFormApi>;

const defaultHint = (property: ConfigStringProperty | ConfigNumberProperty): string | undefined => (property.default === undefined ? undefined : `Default: ${property.default}`);

export const SchemaForm = component<SchemaFormProps>(
    ({ props, emit, expose }) => {
        const source = (): Readonly<Record<string, unknown>> => props.value ?? {};
        const draft = signal<SchemaDraft>(toSchemaDraft(props.schema, source()));
        const ui = signal({ attempted: false });
        let opened = source();
        const errors = computed(() => validateSchemaDraft(props.schema, draft, opened));
        const shown = (): SchemaErrors => (ui.attempted ? errors.value : {});
        const built = (d: SchemaDraft): Record<string, unknown> => fromSchemaDraft(props.schema, d, opened);
        // Dirty against the canonical form of the config the draft was opened on, so an untouched draft is clean.
        const dirty = (): boolean => JSON.stringify(built(draft)) !== JSON.stringify(built(toSchemaDraft(props.schema, opened)));

        const reset = () => {
            batch(() => {
                opened = source();
                Object.assign(draft, toSchemaDraft(props.schema, opened));
                ui.attempted = false;
            });
        };
        // A live read moved the stored config (or the schema changed with a new build): follow it unless the user is mid-edit.
        watch(
            () => [props.schema, JSON.stringify(source())] as const,
            () => {
                if (!dirty()) reset();
            }
        );

        const submit = (): boolean => {
            ui.attempted = true;
            const e = errors.value;
            if (Object.keys(e).length) {
                emit('invalid', e);
                return false;
            }
            emit('submit', built(draft));
            return true;
        };
        const load = (config: Readonly<Record<string, unknown>>) => {
            Object.assign(draft, toSchemaDraft(props.schema, config));
        };
        watch(
            () => JSON.stringify(built(draft)),
            () => emit('change', built(draft))
        );
        expose({ reset, submit, errors: () => errors.value, dirty, draft, value: () => built(draft), load });

        const onSubmit = (e: Event) => {
            e.preventDefault();
            submit();
        };

        const control = (f: SchemaField, err: SchemaErrors) => {
            const name = props.name ? `${props.name}.${f.key}` : f.key;
            const common = { key: f.key, name, label: f.label, description: f.description, error: err[f.key], required: f.required };
            switch (f.kind) {
                case 'text': {
                    const p = f.property as ConfigStringProperty;
                    return <TextField {...common} model={() => draft.text[f.key]!} type={p.format === 'uri' ? 'url' : 'text'} placeholder={defaultHint(p)} />;
                }
                case 'select': {
                    const p = f.property as ConfigStringProperty;
                    return <SelectField {...common} model={() => draft.text[f.key]!} options={(p.enum ?? []).map((value) => ({ value }))} placeholder={f.required ? 'Choose…' : 'Not set'} />;
                }
                case 'number': {
                    const p = f.property as ConfigNumberProperty;
                    return <NumberField {...common} model={() => draft.number[f.key]!} min={p.minimum} max={p.maximum} step={p.type === 'integer' ? 1 : undefined} placeholder={defaultHint(p)} />;
                }
                case 'switch':
                    return <SwitchField {...common} model={() => draft.flag[f.key]!} />;
                case 'list': {
                    const allowed = (f.property as ConfigStringArrayProperty).items.enum;
                    return <MultiSelectField {...common} model={() => draft.list[f.key]!} options={(allowed ?? []).map((value) => ({ value }))} allowCustom={!allowed} />;
                }
                case 'map':
                    return <MapField {...common} model={() => draft.map[f.key]!} />;
            }
        };

        return () => {
            const fields = schemaFields(props.schema);
            const err = shown();
            // What no field can show: the config as a whole, or a key the schema does not draw.
            const drawn = new Set(fields.map((f) => f.key));
            const stray = Object.entries(err).filter(([key]) => !drawn.has(key));
            const busy = !!props.disabled || !!props.saving;
            return (
                <form data-scope="ai-form" data-part="root" data-form="schema" action={props.action} method={props.method ?? 'post'} onSubmit={onSubmit} noValidate>
                    {fields.length === 0 ? (
                        <p data-scope="ai-form" data-part="hint" data-empty="">
                            Nothing to configure.
                        </p>
                    ) : (
                        <fieldset data-scope="ai-form" data-part="section" data-section="config" disabled={busy}>
                            <legend data-scope="ai-form" data-part="section-title" data-visually-hidden="">
                                Configuration
                            </legend>
                            {fields.map((f) => control(f, err))}
                        </fieldset>
                    )}
                    {stray.length || props.error ? (
                        <ErrorNote data-form-summary="">
                            {props.error ? <p>{props.error}</p> : null}
                            {stray.map(([key, message]) => (
                                <p key={key}>{key ? `${key}: ${message}` : message}</p>
                            ))}
                        </ErrorNote>
                    ) : null}
                    {props.hideActions || fields.length === 0 ? null : (
                        <div data-scope="ai-form" data-part="actions">
                            <Button type="submit" intent="primary" loading={props.saving} disabled={props.disabled}>
                                {props.submitLabel ?? 'Save'}
                            </Button>
                            <Button disabled={busy} onClick={reset}>
                                Reset
                            </Button>
                        </div>
                    )}
                </form>
            );
        };
    },
    { name: 'SchemaForm' }
);
