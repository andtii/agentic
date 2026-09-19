/**
 * The plugin pages' view model (#233): pure adapters from the Registry's
 * `overview()` and `dependentsAll()` to what the catalogue and a plugin's
 * page draw. Nothing here touches a hook or the DOM; the mock pages feed the
 * same functions from `mock/ops.ts`.
 */
import { USAGE_LIMITS_CAPABILITY, isSingleSlot, runtimeKindOf, type PermissionScope, type PluginKind, type PluginManifest, type PluginReadiness, type RuntimeKind } from '@agentic/core';
import type { Dependents, MemorySwitchReport, PluginView } from '@agentic/platform';
import { dependentCount } from '../ops/live';

/** The catalogue's sections, in the order a person sets a workspace up: what runs agents, what they reach, what they keep. */
export const KIND_ORDER: readonly PluginKind[] = ['runtime', 'connector', 'memory', 'learning', 'notification', 'trigger', 'a2a', 'project-feature'];

export const KIND_TITLE: Record<PluginKind, string> = {
    runtime: 'Runtimes',
    connector: 'Connectors',
    memory: 'Memory',
    learning: 'Learning',
    notification: 'Notifications',
    trigger: 'Triggers',
    a2a: 'A2A',
    'project-feature': 'Project features'
};

/** Runtimes are split by what they are (#313): harness, model, remote — each its own section, in this order. */
export const RUNTIME_KIND_ORDER: readonly RuntimeKind[] = ['harness', 'model', 'remote'];

export const RUNTIME_KIND_TITLE: Record<RuntimeKind, string> = {
    harness: 'Harness runtimes',
    model: 'Model runtimes',
    remote: 'Remote agents'
};

/** One line under each runtime section: what makes a runtime this kind. */
export const RUNTIME_KIND_NOTE: Record<RuntimeKind, string> = {
    harness: 'Agent products with their own loop, tools and sign-in — driven through their CLI or SDK on a paired machine, under that machine’s account.',
    model: 'The platform runs the agent loop itself, calling a model API with your key.',
    remote: 'Independently hosted agents, reached over A2A.'
};

/** The kind tag a card and a plugin's page show: `harness runtime`, `model runtime`, `remote agent`, else the plugin kind. */
export function kindLabel(m: Pick<PluginManifest, 'kind' | 'capabilities'>): string {
    const runtime = runtimeKindOf(m);
    return runtime === 'remote' ? 'remote agent' : runtime ? `${runtime} runtime` : m.kind;
}

/** What a plugin does beyond its kind, as tags: a runtime that reports its accounts' plan usage limits (#261). */
export function featuresOf(m: Pick<PluginManifest, 'capabilities'>): string[] {
    return m.capabilities.includes(USAGE_LIMITS_CAPABILITY) ? ['usage limits'] : [];
}

export interface PluginGroup {
    /** `runtime:harness`, `runtime:model`, `runtime:remote`, `runtime` (declares no runtime kind), or the plugin kind. */
    readonly key: string;
    readonly kind: PluginKind;
    readonly title: string;
    readonly note?: string;
    readonly plugins: readonly PluginView[];
}

/** The plugins by kind, `KIND_ORDER`, runtimes split by `RUNTIME_KIND_ORDER`; empty groups left out; a kind this build does not know sorts last. */
export function groupByKind(plugins: readonly PluginView[]): PluginGroup[] {
    const kinds = [...KIND_ORDER, ...new Set(plugins.map((p) => p.manifest.kind).filter((k) => !KIND_ORDER.includes(k)))];
    const groups: PluginGroup[] = [];
    for (const kind of kinds) {
        const ofKind = plugins.filter((p) => p.manifest.kind === kind);
        if (kind !== 'runtime') {
            groups.push({ key: kind, kind, title: KIND_TITLE[kind] ?? kind, plugins: ofKind });
            continue;
        }
        for (const rk of RUNTIME_KIND_ORDER) groups.push({ key: `runtime:${rk}`, kind, title: RUNTIME_KIND_TITLE[rk], note: RUNTIME_KIND_NOTE[rk], plugins: ofKind.filter((p) => runtimeKindOf(p.manifest) === rk) });
        groups.push({ key: 'runtime', kind, title: KIND_TITLE.runtime, plugins: ofKind.filter((p) => runtimeKindOf(p.manifest) === undefined) });
    }
    return groups.filter((g) => g.plugins.length);
}

/** `dependentsAll()` by plugin id. */
export const dependentsById = (rows: readonly Dependents[]): Record<string, Dependents> => Object.fromEntries(rows.map((d) => [d.pluginId, d]));

/** The route of a plugin's page; ids carry dots and colons (`agentic.memory.default`, `a2a:peer`). */
export const pluginHref = (id: string): string => `/plugins/${encodeURIComponent(id)}`;

/**
 * What turning the workspace's ACTIVE memory or learning plugin off does.
 * Every agent's new sessions run on it, so the Registry singles nobody out
 * (`Dependents.workspaceWide`) and the page states the consequence instead.
 */
export function workspaceWideConsequence(kind: PluginKind): string {
    if (kind === 'memory') return 'Every agent uses it: new sessions recall nothing and remember nothing while it is off. Stored memories are kept.';
    if (kind === 'learning') return 'Every agent uses it: finished tasks and corrections stop producing lessons while it is off. What was learned is kept.';
    return 'Every agent in the workspace uses it.';
}

/** Whether turning it off has to be confirmed: someone references it, or the whole workspace runs on it. */
export const needsConfirm = (deps: Dependents | undefined): boolean => !!deps && (dependentCount(deps) > 0 || deps.workspaceWide === true);

/** Turning this off leaves no runtime an agent could start work on. */
export function isLastReadyRuntime(plugin: PluginView, readiness: Readonly<Record<string, PluginReadiness>>, plugins: readonly PluginView[]): boolean {
    if (plugin.manifest.kind !== 'runtime' || readiness[plugin.manifest.id]?.status !== 'ready') return false;
    return !plugins.some((p) => p.manifest.kind === 'runtime' && p.manifest.id !== plugin.manifest.id && readiness[p.manifest.id]?.status === 'ready');
}

export const LAST_RUNTIME_WARNING = 'This is the only runtime that is ready. With it off, no agent can start new work until another runtime is set up.';

/** The confirm dialog's description for a disable. */
export function disableDescription(plugin: PluginView, deps: Dependents | undefined, lastRuntime: boolean): string {
    const base = deps?.workspaceWide
        ? workspaceWideConsequence(plugin.manifest.kind)
        : 'These stop being able to start new work with it. Nothing is deleted, nothing running is stopped, and nothing is moved to another runtime.';
    return lastRuntime ? `${base} ${LAST_RUNTIME_WARNING}` : base;
}

export interface PermissionRow {
    readonly scope: PermissionScope;
    readonly reason: string;
    readonly granted: boolean;
}

/** Every scope the manifest declares, with its reason and whether the owner granted it (PLG-04). */
export const permissionRows = (plugin: PluginView): PermissionRow[] => plugin.manifest.permissions.map((p) => ({ scope: p.scope, reason: p.reason, granted: plugin.grantedPermissions.includes(p.scope) }));

/** The declared scopes nobody granted — what the card lists under "Declared, not granted". */
export const ungranted = (plugin: PluginView): PermissionScope[] => plugin.manifest.permissions.filter((p) => !plugin.grantedPermissions.includes(p.scope)).map((p) => p.scope);

/** A single-slot plugin that is not the one the workspace runs — it can be made active. */
export const canActivate = (plugin: PluginView): boolean => isSingleSlot(plugin.manifest.kind) && plugin.enabled && plugin.active !== true;

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The Registry refused because agents or schedules still use the plugin (`plugin-in-use`): offer the forced remove. */
export const isInUse = (e: unknown): boolean => /plugin-in-use|is used by \d+ agent/.test(messageOf(e));

/**
 * A Registry refusal as the page says it. `no-kek` is the one a person can do
 * nothing about from here, so it says who can; the rest keep the Registry's
 * own sentence without its `[registry]` tag.
 */
export function registryErrorText(e: unknown): string {
    const message = messageOf(e);
    if (/no-kek|WORKSPACE_KEK/.test(message)) return 'This deployment cannot store keys: WORKSPACE_KEK is not set. Whoever runs the platform sets it (wrangler secret put WORKSPACE_KEK); nothing was saved.';
    return message.replace(/^\[registry\]\s*/, '');
}

/** What the "Make active" confirmation of a memory plugin says (#243): the dry run's numbers, before anything moves. */
export interface MemorySwitchText {
    readonly title: string;
    readonly description: string;
    /** One line per scope that holds memories, the agent's name for its own scope. */
    readonly scopes: readonly string[];
    readonly confirmLabel: string;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export function memorySwitchText(report: MemorySwitchReport, nameOf: (pluginId: string) => string, agentName: (agentId: string) => string): MemorySwitchText {
    const from = nameOf(report.from);
    const to = nameOf(report.to);
    const title = `Make ${to} active?`;
    if (report.entries === 0) return { title, description: `${from} holds no memories yet, so nothing moves. New sessions remember in ${to}.`, scopes: [], confirmLabel: 'Make active' };
    const parts = [
        report.imported === 0
            ? `Nothing new to move: all ${plural(report.entries, 'memory', 'memories')} in ${from} ${report.entries === 1 ? 'is' : 'are'} already in ${to} or cannot be held there.`
            : `${plural(report.imported, 'memory', 'memories')} of ${report.entries} move from ${from} to ${to}.`
    ];
    if (report.skipped && report.imported > 0) parts.push(`${report.skipped} ${report.skipped === 1 ? 'is' : 'are'} already there or cannot be held, so ${report.skipped === 1 ? 'it stays' : 'they stay'} out.`);
    parts.push(report.droppedFields.length ? `${to} keeps less than ${from}: ${report.droppedFields.join(', ')} ${report.droppedFields.length === 1 ? 'is' : 'are'} dropped.` : 'Nothing is lost.');
    parts.push(`${from} keeps its own copy, so switching back finds it again.`);
    const scopes = report.scopes.map((s) => `${s.scope.startsWith('agent:') ? agentName(s.scope.slice('agent:'.length)) : `Shared: ${s.scope.slice('shared:'.length)}`} · ${plural(s.report.entries, 'memory', 'memories')}`);
    return { title, description: parts.join(' '), scopes, confirmLabel: report.imported === 0 ? 'Make active' : `Move ${plural(report.imported, 'memory', 'memories')} and make active` };
}
