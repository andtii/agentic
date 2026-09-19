/**
 * The draft behind `SchemaForm`: a plugin's `ConfigSchema` (core's typed
 * JSON-Schema subset) read into one bucket per control type, and back into
 * a config. Pure, so a page can build or check a config without the form.
 *
 * The config that comes back is SPARSE: a property left at its manifest
 * default is not written, so a stored config keeps following the manifest
 * (`{ ...configDefaults(schema), ...config }` is how it is read — core's
 * `validateConfig` doc). A key the source already carried stays, and so
 * does anything the form cannot draw (an unknown property kind, or an extra
 * key an open schema allows).
 */

import { configDefaults, validateConfig, type ConfigProperty, type ConfigSchema } from '@agentic/core';

export type SchemaFieldKind = 'text' | 'select' | 'number' | 'switch' | 'list' | 'map';

/** One row of a string-map being edited; rows keep their place while a key is half-typed. */
export interface MapRow {
    key: string;
    value: string;
}

export interface SchemaField {
    readonly key: string;
    readonly kind: SchemaFieldKind;
    readonly label: string;
    readonly description?: string;
    readonly required: boolean;
    readonly property: ConfigProperty;
}

export interface SchemaDraft {
    text: Record<string, string>;
    number: Record<string, number | null>;
    flag: Record<string, boolean>;
    list: Record<string, string[]>;
    map: Record<string, MapRow[]>;
}

/** Field errors by property key; `''` is the config as a whole. */
export type SchemaErrors = Record<string, string>;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function kindOf(property: ConfigProperty): SchemaFieldKind | undefined {
    switch (property.type) {
        case 'string':
            return property.enum ? 'select' : 'text';
        case 'number':
        case 'integer':
            return 'number';
        case 'boolean':
            return 'switch';
        case 'array':
            return 'list';
        case 'object':
            return 'map';
        default:
            return undefined;
    }
}

/** `defaultModel` → "Default model"; a `title` wins. */
export function schemaLabel(key: string, title?: string): string {
    if (title) return title;
    const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
    return words ? words[0]!.toUpperCase() + words.slice(1) : key;
}

/** The properties the form can draw, in declaration order; a kind it does not know is skipped (and preserved). */
export function schemaFields(schema: ConfigSchema): SchemaField[] {
    const required = new Set(schema.required ?? []);
    const out: SchemaField[] = [];
    for (const [key, property] of Object.entries(schema.properties ?? {})) {
        const kind = kindOf(property);
        if (!kind) continue;
        out.push({ key, kind, label: schemaLabel(key, property.title), ...(property.description ? { description: property.description } : {}), required: required.has(key), property });
    }
    return out;
}

export function toSchemaDraft(schema: ConfigSchema, value: Readonly<Record<string, unknown>> = {}): SchemaDraft {
    const shown: Record<string, unknown> = { ...configDefaults(schema), ...value };
    const draft: SchemaDraft = { text: {}, number: {}, flag: {}, list: {}, map: {} };
    for (const { key, kind } of schemaFields(schema)) {
        const v = shown[key];
        switch (kind) {
            case 'text':
            case 'select':
                draft.text[key] = typeof v === 'string' ? v : '';
                break;
            case 'number':
                draft.number[key] = typeof v === 'number' && Number.isFinite(v) ? v : null;
                break;
            case 'switch':
                draft.flag[key] = v === true;
                break;
            case 'list':
                draft.list[key] = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
                break;
            case 'map':
                draft.map[key] = isRecord(v) ? Object.entries(v).map(([k, x]) => ({ key: k, value: typeof x === 'string' ? x : '' })) : [];
                break;
        }
    }
    return draft;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** What the draft holds for one field; `undefined` is "not set". An emptied list or map is `undefined` unless it overrides a non-empty default. */
function drafted(field: SchemaField, draft: SchemaDraft, fallback: unknown): unknown {
    const { key } = field;
    switch (field.kind) {
        case 'text':
        case 'select': {
            const s = (draft.text[key] ?? '').trim();
            return s === '' ? undefined : s;
        }
        case 'number':
            return draft.number[key] ?? undefined;
        case 'switch':
            return draft.flag[key] === true;
        case 'list': {
            const list = [...(draft.list[key] ?? [])];
            return list.length > 0 || (Array.isArray(fallback) && fallback.length > 0) ? list : undefined;
        }
        case 'map': {
            const rows = (draft.map[key] ?? []).filter((r) => r.key.trim() !== '');
            // Entries, not assignment: a `__proto__` row stays data.
            const map: Record<string, string> = Object.fromEntries(rows.map((r) => [r.key.trim(), r.value]));
            return rows.length > 0 || (isRecord(fallback) && Object.keys(fallback).length > 0) ? map : undefined;
        }
    }
}

/** The sparse config the draft stands for, over `source` (the config it was opened on). */
export function fromSchemaDraft(schema: ConfigSchema, draft: SchemaDraft, source: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
    const defaults = configDefaults(schema);
    const drawn = new Set<string>();
    const out: [string, unknown][] = [];
    for (const field of schemaFields(schema)) {
        drawn.add(field.key);
        const v = drafted(field, draft, defaults[field.key]);
        if (v === undefined) continue;
        if (Object.hasOwn(source, field.key) || !same(v, defaults[field.key])) out.push([field.key, v]);
    }
    for (const [key, v] of Object.entries(source)) if (!drawn.has(key) && v !== undefined) out.push([key, v]);
    return Object.fromEntries(out);
}

const sentence = (message: string): string => (message ? message[0]!.toUpperCase() + message.slice(1) : message);

/** Core's verdict on the drafted config (read over the defaults, as the platform reads it), plus what only a half-edited map can get wrong. */
export function validateSchemaDraft(schema: ConfigSchema, draft: SchemaDraft, source: Readonly<Record<string, unknown>> = {}): SchemaErrors {
    const errors: SchemaErrors = {};
    for (const field of schemaFields(schema)) {
        if (field.kind !== 'map') continue;
        const rows = draft.map[field.key] ?? [];
        const keys = rows.map((r) => r.key.trim());
        if (rows.some((r) => r.key.trim() === '' && r.value !== '')) errors[field.key] = 'Every row needs a name';
        else if (new Set(keys.filter(Boolean)).size !== keys.filter(Boolean).length) errors[field.key] = 'Each name can appear once';
    }
    const checked = validateConfig(schema, { ...configDefaults(schema), ...fromSchemaDraft(schema, draft, source) });
    if (!checked.ok) for (const e of checked.errors) errors[e.path] ??= sentence(e.message);
    return errors;
}
