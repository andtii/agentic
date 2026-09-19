/**
 * Plugin configuration (PLG-02): the schema a manifest declares, the check a
 * stored config passes, and one readiness verdict the UI and the platform share.
 * Pure — nothing here hops anywhere; callers bring the facts.
 */

import type { RuntimeId } from './agent.js';
import type { PermissionScope, PluginState } from './plugin.js';

interface ConfigPropertyBase {
    readonly title?: string;
    readonly description?: string;
}

/** Free text, a choice (`enum`) or an absolute URL (`format: 'uri'`). */
export interface ConfigStringProperty extends ConfigPropertyBase {
    readonly type: 'string';
    readonly enum?: readonly string[];
    readonly format?: 'uri';
    readonly default?: string;
}

export interface ConfigNumberProperty extends ConfigPropertyBase {
    readonly type: 'number' | 'integer';
    readonly minimum?: number;
    readonly maximum?: number;
    readonly default?: number;
}

export interface ConfigBooleanProperty extends ConfigPropertyBase {
    readonly type: 'boolean';
    readonly default?: boolean;
}

export interface ConfigStringArrayProperty extends ConfigPropertyBase {
    readonly type: 'array';
    readonly items: { readonly type: 'string'; readonly enum?: readonly string[] };
    readonly default?: readonly string[];
}

/** A string → string map (headers, process environment). */
export interface ConfigStringMapProperty extends ConfigPropertyBase {
    readonly type: 'object';
    readonly additionalProperties: { readonly type: 'string' };
    readonly default?: Readonly<Record<string, string>>;
}

export type ConfigProperty = ConfigStringProperty | ConfigNumberProperty | ConfigBooleanProperty | ConfigStringArrayProperty | ConfigStringMapProperty;

/**
 * A plugin's config shape: a typed SUBSET of JSON Schema, small enough to
 * validate without a library and to render as a form. Secrets are never
 * properties here — a manifest declares them in `secrets`.
 *
 * Unknown keys: with `properties` declared they are rejected unless
 * `additionalProperties: true`; a bare `{ type: 'object' }` (or `{}`, which
 * manifests written before the schema was typed use) constrains nothing.
 */
export interface ConfigSchema {
    readonly type?: 'object';
    readonly properties?: Readonly<Record<string, ConfigProperty>>;
    readonly required?: readonly string[];
    readonly additionalProperties?: boolean;
}

/** A secret a plugin needs: stored sealed by the Registry under `name`, granted through `secret:<name>` (PLG-04). */
export interface PluginSecretDeclaration {
    readonly name: string;
    readonly title: string;
    readonly description: string;
    readonly required: boolean;
}

export interface ConfigError {
    /** The property the error is about; `''` for the config as a whole. */
    readonly path: string;
    readonly message: string;
}

export type ConfigValidation = { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false; readonly errors: readonly ConfigError[] };

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function isAbsoluteUrl(value: string): boolean {
    try {
        new URL(value);
        return true;
    } catch {
        return false;
    }
}

function propertyError(property: ConfigProperty, value: unknown): string | undefined {
    switch (property.type) {
        case 'string':
            if (typeof value !== 'string') return 'must be a string';
            if (property.enum && !property.enum.includes(value)) return `must be one of ${property.enum.join(', ')}`;
            if (property.format === 'uri' && !isAbsoluteUrl(value)) return 'must be an absolute URL';
            return undefined;
        case 'number':
        case 'integer':
            if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a number';
            if (property.type === 'integer' && !Number.isInteger(value)) return 'must be a whole number';
            if (property.minimum !== undefined && value < property.minimum) return `must be at least ${property.minimum}`;
            if (property.maximum !== undefined && value > property.maximum) return `must be at most ${property.maximum}`;
            return undefined;
        case 'boolean':
            return typeof value === 'boolean' ? undefined : 'must be true or false';
        case 'array': {
            if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) return 'must be a list of strings';
            const allowed = property.items.enum;
            const stray = allowed ? (value as string[]).find((v) => !allowed.includes(v)) : undefined;
            return stray === undefined ? undefined : `"${stray}" is not one of ${allowed!.join(', ')}`;
        }
        case 'object':
            return isRecord(value) && Object.values(value).every((v) => typeof v === 'string') ? undefined : 'must be a map of strings';
    }
}

/**
 * Check `value` against `schema`. `undefined` counts as absent. The value comes
 * back as given (a shallow copy, absent keys dropped) — defaults are NOT filled
 * in, so a stored config keeps following the manifest's defaults; read through
 * `{ ...configDefaults(schema), ...config }`.
 */
export function validateConfig(schema: ConfigSchema, value: unknown): ConfigValidation {
    if (!isRecord(value)) return { ok: false, errors: [{ path: '', message: 'must be an object' }] };
    const properties = schema.properties ?? {};
    const open = schema.additionalProperties ?? schema.properties === undefined;
    const errors: ConfigError[] = [];
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
        if (v === undefined) continue;
        const property = Object.hasOwn(properties, key) ? properties[key] : undefined;
        if (!property) {
            if (open) out[key] = v;
            else errors.push({ path: key, message: 'is not a setting of this plugin' });
            continue;
        }
        const message = propertyError(property, v);
        if (message) errors.push({ path: key, message });
        else out[key] = v;
    }
    for (const key of schema.required ?? []) {
        if (value[key] === undefined) errors.push({ path: key, message: 'is required' });
    }
    return errors.length > 0 ? { ok: false, errors } : { ok: true, value: out };
}

/** The `default` of every property that declares one. */
export function configDefaults(schema: ConfigSchema): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, property] of Object.entries(schema.properties ?? {})) {
        if (property.default === undefined) continue;
        out[key] = Array.isArray(property.default) ? [...property.default] : isRecord(property.default) ? { ...property.default } : property.default;
    }
    return out;
}

/** The capability a `runtime` plugin lists when its sessions run on a machine's daemon: it needs an environment of that runtime. */
export const DAEMON_HOSTED_CAPABILITY = 'daemon-hosted';

export type PluginReadinessStatus = 'ready' | 'disabled' | 'needs-config' | 'needs-secret' | 'needs-grant' | 'needs-machine' | 'no-kek';

export interface PluginReadiness {
    readonly status: PluginReadinessStatus;
    /** What is missing: config paths, secret names, scopes, or the runtime id without an environment. */
    readonly missing?: readonly string[];
}

/** What the caller knows about the workspace; `pluginReadiness` looks nothing up. */
export interface PluginReadinessFacts {
    /** Names of the secrets the Registry holds. */
    readonly secretNames: readonly string[];
    /** The workspace's environments, every machine (`EnvironmentDescriptor`s fit). */
    readonly environments: readonly { readonly runtime: RuntimeId }[];
    /** Whether the deployment can seal secrets at all (`WORKSPACE_KEK`). */
    readonly hasKek: boolean;
}

function covered(granted: readonly PermissionScope[], scope: PermissionScope): boolean {
    if (granted.includes(scope)) return true;
    const family = scope.slice(0, scope.indexOf(':') + 1);
    return granted.includes(`${family}*` as PermissionScope);
}

/**
 * Whether a plugin can be used now, and the first thing in the way: disabled,
 * then config, then secrets (no key to seal them with, or not set), then
 * ungranted declared scopes, then — for a daemon-hosted runtime — no
 * environment of that runtime on any machine.
 */
export function pluginReadiness(state: PluginState, facts: PluginReadinessFacts): PluginReadiness {
    const { manifest } = state;
    if (!state.enabled) return { status: 'disabled' };
    const checked = validateConfig(manifest.config, { ...configDefaults(manifest.config), ...state.config });
    if (!checked.ok) return { status: 'needs-config', missing: [...new Set(checked.errors.map((e) => e.path))] };
    const unset = (manifest.secrets ?? []).filter((s) => s.required && !facts.secretNames.includes(s.name)).map((s) => s.name);
    if (unset.length > 0) return facts.hasKek ? { status: 'needs-secret', missing: unset } : { status: 'no-kek', missing: unset };
    const ungranted = [...new Set(manifest.permissions.map((p) => p.scope))].filter((scope) => !covered(state.grantedPermissions, scope));
    if (ungranted.length > 0) return { status: 'needs-grant', missing: ungranted };
    if (manifest.kind === 'runtime' && manifest.capabilities.includes(DAEMON_HOSTED_CAPABILITY) && !facts.environments.some((e) => e.runtime === manifest.id)) {
        return { status: 'needs-machine', missing: [manifest.id] };
    }
    return { status: 'ready' };
}
