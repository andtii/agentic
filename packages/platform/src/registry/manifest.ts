/** Manifest and permission-scope validation — a bad manifest never becomes durable state (PLG-01, PLG-04). */

import type { PermissionScope, PluginKind, PluginManifest } from '@agentic/core';
import { RegistryError } from './errors.js';

export const PLUGIN_KINDS: readonly PluginKind[] = ['runtime', 'connector', 'memory', 'learning', 'notification', 'trigger', 'a2a'];

/** Plugin ids, connector ids and secret names share one alphabet: letters, digits, `.`, `_`, `-`. */
export const NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;

const SCOPE_RE = /^(secret:(\*|[A-Za-z0-9._-]+)|machine:(\*|[A-Za-z0-9._-]+)|network:[A-Za-z0-9.:_[\]-]+|memory:(read|write)|tools:(\*|[A-Za-z0-9._-]+))$/;

export function isPermissionScope(value: unknown): value is PermissionScope {
    return typeof value === 'string' && SCOPE_RE.test(value);
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
    const secrets = m.secrets ?? [];
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
    if (!isRecord(m.compat) || typeof m.compat.platform !== 'string' || typeof m.compat.core !== 'string') bad('compat');
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
