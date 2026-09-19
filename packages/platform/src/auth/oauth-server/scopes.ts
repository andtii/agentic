/**
 * The scope list an external client can be granted — exactly core's `Scope`
 * union (the tool families of the orchestration surface, architecture §9).
 * The `Record<Scope, true>` makes a scope added to core fail typecheck here
 * until it is listed, so the metadata never advertises less than exists.
 */
import type { Scope } from '@agentic/core';

const SCOPE_SET: Readonly<Record<Scope, true>> = {
    machines: true,
    environments: true,
    agents: true,
    sessions: true,
    tasks: true,
    chats: true,
    memory: true,
    schedules: true,
    usage: true
};

export const ALL_SCOPES: readonly Scope[] = Object.keys(SCOPE_SET) as Scope[];

export function isScope(value: unknown): value is Scope {
    return typeof value === 'string' && Object.hasOwn(SCOPE_SET, value);
}

/**
 * Parse a space-separated `scope` parameter. `null` when any token is not a
 * `Scope` (→ `invalid_scope`); an absent or empty value yields `[]`, which
 * callers turn into the default (every scope the server supports).
 * Duplicates collapse; order is the request's.
 */
export function parseScopes(value: string | null | undefined): Scope[] | null {
    if (!value || !value.trim()) return [];
    const out: Scope[] = [];
    for (const token of value.trim().split(/\s+/)) {
        if (!isScope(token)) return null;
        if (!out.includes(token)) out.push(token);
    }
    return out;
}

export function formatScopes(scopes: readonly Scope[]): string {
    return scopes.join(' ');
}
