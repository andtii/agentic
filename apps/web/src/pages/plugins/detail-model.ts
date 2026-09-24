/**
 * The plugin page's view model (#640; PLG-03, PLG-04, PLG-09, OPS-02,
 * AC-13): pure adapters from what `/plugins/:id` reads — the plugin's view,
 * its tool policy, its connector records, the workspace's secret names and
 * its dependents — to what the page draws (`PluginDetail`, board
 * `PluginDetail`). The live and the mock page feed the same functions.
 *
 * `pluginHead` is the one piece of state here: what the page tells the
 * topbar (the plugin's name and kind, keyed by id like `projects/head.ts`),
 * because the breadcrumb is a pure function of the route and only the page
 * reads the Registry.
 */
import { signal } from 'sigx';
import type { ConfigSchema, PermissionScope, PluginKind, PluginManifest, ToolMode } from '@agentic/core';
import type { ConnectorRecord, Dependents, PluginView } from '@agentic/platform';
import type { TopbarContribution } from '../../components/topbar';
import { isConduitConnector, ownerSecretsOf } from './conduit';

/* ------------------------------------------------------------------ topbar */

export interface PluginHead {
    readonly id: string;
    readonly name: string;
    readonly kind: PluginKind;
}

/** What the live plugin page published for the topbar; `null` until it has read the plugin. */
export const pluginHead = signal<{ value: PluginHead | null }>({ value: null });

/** The topbar trail: Plugins › Connectors › Name for a connector, Plugins › Name otherwise; the id until the name is known. */
export function pluginTrail(id: string, path: string, head: PluginHead | undefined): TopbarContribution {
    if (!head) return { crumb: id };
    if (head.kind !== 'connector') return { crumb: head.name };
    return {
        trail: [
            { label: 'Plugins', href: '/plugins' },
            { label: 'Connectors', href: '/plugins?kind=connector' },
            { label: head.name, href: path }
        ]
    };
}

/* ------------------------------------------------------------------ header */

/** The transport tag beside the kind: `conduit`, `mcp`, `mcp stdio` — only a connector has one. */
export function transportOf(manifest: PluginManifest, records: readonly Pick<ConnectorRecord, 'pluginId' | 'transport'>[] = []): string | undefined {
    if (manifest.kind !== 'connector') return undefined;
    if (isConduitConnector(manifest)) return 'conduit';
    const record = records.find((r) => r.pluginId === manifest.id);
    if (record?.transport === 'conduit') return 'conduit';
    if (record?.transport === 'stdio') return 'mcp stdio';
    return 'mcp';
}

/** Whether the manifest has anything to set: a plugin with an empty schema gets no Settings panel. */
export const hasSettings = (schema: ConfigSchema | undefined): boolean => Object.keys(schema?.properties ?? {}).length > 0;

/* ------------------------------------------------------------------- tools */

export interface ToolRow {
    /** The namespaced name sessions see (`gmail__send-email`). */
    readonly name: string;
    readonly description?: string;
    readonly mode: ToolMode;
    /** A write of this row is in flight. */
    readonly pending?: boolean;
}

/**
 * One row per tool (PLG-03, PLG-09): the manifest's tools in its order, then any other tool the policy knows
 * (what an MCP connector reported), name order. The mode is the write in flight, else the Registry's effective
 * policy, else the manifest's `defaultMode`, else `allow` — the Registry's own fallback.
 */
export function toolRows(
    manifest: Pick<PluginManifest, 'tools'>,
    policy: Readonly<Record<string, ToolMode>> | undefined,
    optimistic: Readonly<Record<string, ToolMode>> = {},
    reported: readonly string[] = []
): ToolRow[] {
    const declared = manifest.tools ?? [];
    const names = new Set(declared.map((t) => t.name));
    const extra = [...new Set([...Object.keys(policy ?? {}), ...reported])].filter((n) => !names.has(n)).sort();
    const rows = [...declared.map((t) => ({ name: t.name, description: t.title ?? t.description, defaultMode: t.defaultMode })), ...extra.map((name) => ({ name, description: undefined, defaultMode: undefined }))];
    return rows.map((t) => {
        const pending = Object.hasOwn(optimistic, t.name);
        return {
            name: t.name,
            ...(t.description ? { description: t.description } : {}),
            mode: (pending ? optimistic[t.name] : undefined) ?? policy?.[t.name] ?? t.defaultMode ?? 'allow',
            ...(pending ? { pending: true } : {})
        };
    });
}

/** The tools a `tools:` scope covers: `tools:*` every one, `tools:<ns>` those named `<ns>__…`. */
export function toolsOfScope(scope: PermissionScope, tools: readonly string[]): string[] {
    if (!scope.startsWith('tools:')) return [];
    const ns = scope.slice('tools:'.length);
    return ns === '*' ? [...tools] : tools.filter((t) => t.startsWith(`${ns}__`));
}

/** Revoking a `tools:` scope takes tools from agents: the page asks first. */
export const asksBeforeRevoke = (scope: PermissionScope): boolean => scope.startsWith('tools:');

/* ----------------------------------------------------------------- granted */

export interface ScopeRow {
    readonly scope: PermissionScope;
    readonly reason: string;
}

/**
 * The Granted panel (PLG-04): every granted scope with the manifest's reason for it, then every declared scope
 * nobody granted. A grant the manifest no longer declares still shows, so it can be revoked.
 */
export function scopeRows(plugin: Pick<PluginView, 'manifest' | 'grantedPermissions'>): { readonly granted: ScopeRow[]; readonly declared: ScopeRow[] } {
    const reasons = new Map(plugin.manifest.permissions.map((p) => [p.scope, p.reason] as const));
    const held = new Set(plugin.grantedPermissions);
    return {
        granted: plugin.grantedPermissions.map((scope) => ({ scope, reason: reasons.get(scope) ?? 'No longer declared by this version' })),
        declared: plugin.manifest.permissions.filter((p) => !held.has(p.scope)).map((p) => ({ scope: p.scope, reason: p.reason }))
    };
}

/* ----------------------------------------------------------------- account */

const plural = (n: number, one: string, many = `${one}s`): string => `${n === 2 ? 'two' : n} ${n === 1 ? one : many}`;

/** A day as the design writes it: `12 Sep`. */
export function formatDay(ms: number): string {
    const d = new Date(ms);
    return `${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]}`;
}

/** Where a conduit connector's OAuth client comes from: the owner's own, as the secrets it is stored as. */
export function oauthClientText(manifest: PluginManifest, secretNames: readonly string[]): string {
    const own = ownerSecretsOf(manifest);
    const stored = own.filter((n) => secretNames.includes(n)).length;
    if (stored === 0) return 'not saved yet — add it under Keys';
    if (stored < own.length) return `your own · ${stored} of ${own.length} secrets stored`;
    return `your own · stored as ${plural(stored, 'secret')}`;
}

export interface EndpointView {
    /** The server URL, or the command it runs (stdio). */
    readonly endpoint: string;
    /** The secret its token is sent from, and whether it is set. */
    readonly token?: { readonly name: string; readonly set: boolean };
}

/** An MCP connector's Account panel: the endpoint and the token secret, never the token. */
export function endpointOf(plugin: Pick<PluginView, 'manifest' | 'config'>, record: ConnectorRecord | undefined, secretNames: readonly string[]): EndpointView {
    const url = typeof plugin.config['url'] === 'string' ? plugin.config['url'] : record?.url;
    const command = typeof plugin.config['command'] === 'string' ? plugin.config['command'] : record?.command;
    const where = url ?? (command ? `${command}${record?.args?.length ? ` ${record.args.join(' ')}` : ''}${record?.machine ? ` on ${record.machine}` : ''}` : 'not set');
    const tokenName = record?.auth?.bearer ?? Object.values(record?.auth?.headers ?? {})[0] ?? Object.values(record?.auth?.env ?? {})[0] ?? record?.secrets?.[0] ?? plugin.manifest.secrets?.[0]?.name;
    return { endpoint: where, ...(tokenName ? { token: { name: tokenName, set: secretNames.includes(tokenName) } } : {}) };
}

/* ------------------------------------------------------------------ remove */

/** Everything that references the plugin, by name — listed before the Remove button (AC-13). */
export function dependentLines(deps: Dependents | undefined, agentName: (id: string) => string): string[] {
    if (!deps) return [];
    return [
        ...deps.agents.map((a) => `${a.name || agentName(a.id)} — ${a.via.join(', ')}`),
        ...deps.schedules.map((s) => `${s.title} — schedule via ${agentName(s.agentId)}`)
    ];
}

const listOf = (names: readonly string[]): string => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/**
 * What Remove does, stated before the button (OPS-02, AC-13), from `dependents()` and the secrets: the plugin, its
 * settings and connectors go; whoever references it keeps pointing at nothing; stored keys stay until deleted.
 */
export function removeConsequence(plugin: Pick<PluginView, 'manifest'>, deps: Dependents | undefined, secretNames: readonly string[], agentName: (id: string) => string): string {
    const m = plugin.manifest;
    const parts = [m.kind === 'connector' ? `Removes ${m.name}, its settings, its tool policy and its connectors from the workspace.` : `Removes ${m.name} and its settings from the workspace.`];
    if (deps?.workspaceWide) parts.push('Every agent runs on it: make another one active first.');
    const agents = (deps?.agents ?? []).map((a) => a.name || agentName(a.id));
    const schedules = deps?.schedules.length ?? 0;
    if (agents.length || schedules) {
        const who = [...(agents.length ? [listOf(agents)] : []), ...(schedules ? [plural(schedules, 'schedule')] : [])];
        parts.push(`${listOf(who)} still ${agents.length + schedules === 1 ? 'uses' : 'use'} it and will point at nothing.`);
    }
    const stored = (m.secrets ?? []).map((s) => s.name).filter((n) => secretNames.includes(n));
    if (stored.length === 1) parts.push('Its stored secret stays until you delete it under Keys.');
    else if (stored.length) parts.push(`Its ${plural(stored.length, 'stored secret')} stay until you delete them under Keys.`);
    return parts.join(' ');
}
