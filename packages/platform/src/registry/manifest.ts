/** Manifest and permission-scope validation — a bad manifest never becomes durable state (PLG-01, PLG-04). */

import { isProjectFeatureManifest, type PermissionScope, type PluginKind, type PluginManifest, type ToolMode } from '@agentic/core';
import { RegistryError } from './errors.js';

export const PLUGIN_KINDS: readonly PluginKind[] = ['runtime', 'connector', 'memory', 'learning', 'notification', 'trigger', 'a2a', 'project-feature'];

/** Plugin ids, connector ids and secret names share one alphabet: letters, digits, `.`, `_`, `-`. */
export const NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;

const SCOPE_RE = /^(secret:(\*|[A-Za-z0-9._-]+)|machine:(\*|[A-Za-z0-9._-]+)|network:[A-Za-z0-9.:_[\]-]+|memory:(read|write)|tools:(\*|[A-Za-z0-9._-]+))$/;

export function isPermissionScope(value: unknown): value is PermissionScope {
    return typeof value === 'string' && SCOPE_RE.test(value);
}

export const TOOL_MODES: readonly ToolMode[] = ['allow', 'ask', 'deny'];

export function isToolMode(value: unknown): value is ToolMode {
    return TOOL_MODES.includes(value as ToolMode);
}

export function assertName(value: unknown, what: string): asserts value is string {
    if (typeof value !== 'string' || !NAME_RE.test(value)) {
        throw new RegistryError('bad-name', `[registry] ${what} must match ${String(NAME_RE)} (got ${JSON.stringify(value)})`);
    }
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');

export function assertPluginManifest(value: unknown): asserts value is PluginManifest {
    const bad = (why: string): never => {
        throw new RegistryError('bad-manifest', `[registry] bad plugin manifest: ${why}`);
    };
    if (!isRecord(value)) bad('not an object');
    const m = value as Record<string, unknown>;
    if (typeof m.id !== 'string' || !NAME_RE.test(m.id)) bad('id');
    if (typeof m.version !== 'string' || m.version === '') bad('version');
    if (!PLUGIN_KINDS.includes(m.kind as PluginKind)) bad(`kind "${String(m.kind)}"`);
    if (typeof m.name !== 'string' || m.name.trim() === '') bad('name');
    if (typeof m.description !== 'string') bad('description');
    if (!isStringArray(m.capabilities)) bad('capabilities');
    if (!isRecord(m.config)) bad('config');
    if (!Array.isArray(m.permissions)) bad('permissions');
    for (const p of m.permissions as unknown[]) {
        if (!isRecord(p) || !isPermissionScope(p.scope) || typeof p.reason !== 'string') bad(`permission ${JSON.stringify(p)}`);
    }
    // Optional, never null: `secrets` is either absent or a list.
    const secrets = m.secrets === undefined ? [] : m.secrets;
    if (!Array.isArray(secrets)) bad('secrets');
    const scopes = (m.permissions as { scope: PermissionScope }[]).map((p) => p.scope);
    for (const s of secrets as unknown[]) {
        if (!isRecord(s) || typeof s.name !== 'string' || !NAME_RE.test(s.name) || typeof s.title !== 'string' || typeof s.description !== 'string' || typeof s.required !== 'boolean') {
            bad(`secret ${JSON.stringify(s)}`);
        }
        // PLG-04: a secret the manifest names is one it must ask for.
        const name = (s as { name: string }).name;
        if (!scopeCovered(scopes, `secret:${name}`)) bad(`secret "${name}" needs a secret:${name} permission`);
    }
    // Optional, never null: `tools` (PLG-09) is either absent or a list of uniquely named tools, each with an optional `defaultMode` (a `ToolMode`; absent reads as `allow`).
    const tools = m.tools === undefined ? [] : m.tools;
    if (!Array.isArray(tools)) bad('tools');
    const toolNames = new Set<string>();
    for (const t of tools as unknown[]) {
        if (!isRecord(t) || typeof t.name !== 'string' || t.name.trim() === '') bad(`tool ${JSON.stringify(t)}`);
        const { name, title, description, defaultMode } = t as Record<string, unknown>;
        if (toolNames.has(name as string)) bad(`tool "${String(name)}" is declared twice`);
        toolNames.add(name as string);
        if (title !== undefined && typeof title !== 'string') bad(`tool "${String(name)}" title`);
        if (description !== undefined && typeof description !== 'string') bad(`tool "${String(name)}" description`);
        if (defaultMode !== undefined && !isToolMode(defaultMode)) bad(`tool "${String(name)}" defaultMode "${String(defaultMode)}"`);
    }
    if (!isRecord(m.compat) || typeof m.compat.platform !== 'string' || typeof m.compat.core !== 'string') bad('compat');
    // A project feature (#332) declares the schema of what a project stores under `features[id]`.
    if (m.kind === 'project-feature' && !isProjectFeatureManifest(value as PluginManifest)) bad('a project-feature manifest needs a projectSettings schema');
}

/** The scopes a manifest declares — the only ones that can ever be granted (PLG-04). */
export function declaredScopes(manifest: PluginManifest): readonly PermissionScope[] {
    return [...new Set(manifest.permissions.map((p) => p.scope))];
}

/** `granted` covers `scope`: exact, or the `*` form of the same family. */
export function scopeCovered(granted: readonly PermissionScope[], scope: PermissionScope): boolean {
    if (granted.includes(scope)) return true;
    const family = scope.slice(0, scope.indexOf(':') + 1);
    return granted.includes(`${family}*` as PermissionScope);
}
