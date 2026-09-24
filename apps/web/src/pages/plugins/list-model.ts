/**
 * The `/plugins` list's view model (#637, board `Plugins`): the category menu,
 * the search, the status chips, the needs-attention box and the rows' tags.
 * Pure — no hook, no DOM — so the live and the mock page draw from the same
 * functions, and each is tested on its own (`plugins-list-model.test.ts`).
 */
import { runtimeKindOf, type PluginKind, type PluginManifest, type PluginReadiness, type PluginReadinessStatus, type RuntimeKind } from '@agentic/core';
import type { PluginView } from '@agentic/platform';
import { isConduitConnector } from './conduit';
import { KIND_ORDER, RUNTIME_KIND_ORDER, pluginHref } from './model';

type Readiness = Readonly<Record<string, PluginReadiness>>;

/** The menu's two items above the kinds. */
export const ALL_ID = 'all';
export const ATTENTION_ID = 'attention';

/** The status chips, in order. */
export type StatusFilter = 'all' | 'on' | 'off' | 'needs-setup';
export const STATUS_FILTERS: readonly { readonly id: StatusFilter; readonly label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'on', label: 'On' },
    { id: 'off', label: 'Off' },
    { id: 'needs-setup', label: 'Needs setup' }
];

/** A `?status=` value as a filter; anything else is All. */
export const statusFilterOf = (v: string | undefined): StatusFilter => (STATUS_FILTERS.some((s) => s.id === v) ? (v as StatusFilter) : 'all');

/** What the page's URL holds: `?kind=&status=&q=`. */
export interface ListQuery {
    readonly kind?: string;
    readonly status?: StatusFilter;
    readonly q?: string;
}

/** The `/plugins` URL of a query; empty parts are left out, so the plain page stays `/plugins`. */
export function pluginsHref(query: ListQuery): string {
    const params = new URLSearchParams();
    if (query.kind && query.kind !== ALL_ID) params.set('kind', query.kind);
    if (query.status && query.status !== 'all') params.set('status', query.status);
    if (query.q?.trim()) params.set('q', query.q.trim());
    const s = params.toString();
    return s ? `/plugins?${s}` : '/plugins';
}

/** Turned on, but core's `pluginReadiness` says something is still in the way. */
export function needsSetup(p: PluginView, readiness: Readiness): boolean {
    const status = readiness[p.manifest.id]?.status;
    return p.enabled && status !== undefined && status !== 'ready' && status !== 'disabled';
}

/**
 * Whether a plugin is in a menu category: `attention`, a runtime kind
 * (`harness`, `model`, `remote`), `runtime` (every runtime) or a plugin kind;
 * no kind, or `all`, is every plugin.
 */
export function inCategory(p: PluginView, kind: string | undefined, readiness: Readiness): boolean {
    if (!kind || kind === ALL_ID) return true;
    if (kind === ATTENTION_ID) return needsSetup(p, readiness);
    if ((RUNTIME_KIND_ORDER as readonly string[]).includes(kind)) return runtimeKindOf(p.manifest) === kind;
    return p.manifest.kind === kind;
}

/**
 * Whether a plugin matches the search: every word of `q` appears in its name,
 * description, id, a tool name (`manifest.tools`) or a permission scope — so
 * "googleapis" finds Gmail through `network:gmail.googleapis.com`.
 */
export function matchPlugin(p: Pick<PluginView, 'manifest'>, q: string | undefined): boolean {
    const words = (q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const m = p.manifest;
    const hay = [m.name, m.description, m.id, ...(m.tools ?? []).flatMap((t) => [t.name, t.title ?? '']), ...m.permissions.map((s) => s.scope)].join('\n').toLowerCase();
    return words.every((w) => hay.includes(w));
}

export function matchStatus(p: PluginView, status: StatusFilter, readiness: Readiness): boolean {
    if (status === 'on') return p.enabled;
    if (status === 'off') return !p.enabled;
    if (status === 'needs-setup') return needsSetup(p, readiness);
    return true;
}

/** The chips' counts: within the category and the search, so each says what picking it would show. */
export function statusCounts(plugins: readonly PluginView[], readiness: Readiness): Record<StatusFilter, number> {
    return {
        all: plugins.length,
        on: plugins.filter((p) => p.enabled).length,
        off: plugins.filter((p) => !p.enabled).length,
        'needs-setup': plugins.filter((p) => needsSetup(p, readiness)).length
    };
}

/** The plugins the page lists for a query: category, then search, then status. */
export function filterPlugins(plugins: readonly PluginView[], readiness: Readiness, query: ListQuery): PluginView[] {
    return plugins.filter((p) => inCategory(p, query.kind, readiness) && matchPlugin(p, query.q) && matchStatus(p, query.status ?? 'all', readiness));
}

export interface MenuItem {
    readonly id: string;
    readonly label: string;
    readonly count: number;
    readonly badge?: boolean;
    readonly href: string;
}

export interface MenuGroup {
    readonly label?: string;
    readonly items: readonly MenuItem[];
}

const RUNTIME_MENU_LABEL: Record<RuntimeKind, string> = { harness: 'Harness', model: 'Model', remote: 'Remote agents' };
const KIND_MENU_LABEL: Record<PluginKind, string> = {
    runtime: 'Runtimes',
    connector: 'Connectors',
    notification: 'Notifications',
    trigger: 'Triggers',
    a2a: 'A2A',
    memory: 'Memory',
    learning: 'Learning',
    'project-feature': 'Project features'
};

/** The menu's sections under All and Needs attention: every `KIND_ORDER` kind, runtimes split by `RUNTIME_KIND_ORDER`. */
const MENU_SECTIONS: readonly { readonly label: string; readonly kinds: readonly PluginKind[] }[] = [
    { label: 'Runtimes', kinds: ['runtime'] },
    { label: 'Reach', kinds: ['connector', 'notification', 'trigger', 'a2a'] },
    { label: 'Keep', kinds: ['memory', 'learning'] },
    { label: 'Projects', kinds: ['project-feature'] }
];

/**
 * The category menu (board `Plugins`): All plugins and Needs attention (an
 * amber count badge), then Runtimes (Harness, Model, Remote agents), Reach
 * (Connectors, Notifications, Triggers, A2A), Keep (Memory, Learning) and
 * Projects (Project features). Empty categories stay, with `0`. Each link
 * keeps the page's search and status, so they combine with the category.
 */
export function pluginMenu(plugins: readonly PluginView[], readiness: Readiness, keep: Pick<ListQuery, 'q' | 'status'> = {}): MenuGroup[] {
    const item = (id: string, label: string, count: number, badge?: boolean): MenuItem => ({ id, label, count, ...(badge ? { badge } : {}), href: pluginsHref({ ...keep, kind: id }) });
    const count = (kind: string): number => plugins.filter((p) => inCategory(p, kind, readiness)).length;
    // Every kind the menu offers is one `KIND_ORDER` knows; a section lists them in `KIND_ORDER`'s order within it.
    const sections = MENU_SECTIONS.map((s) => ({ label: s.label, kinds: KIND_ORDER.filter((k) => s.kinds.includes(k)) }));
    return [
        { items: [item(ALL_ID, 'All plugins', plugins.length), item(ATTENTION_ID, 'Needs attention', count(ATTENTION_ID), true)] },
        ...sections.map((s) => ({
            label: s.label,
            items: s.kinds.flatMap((k) => (k === 'runtime' ? RUNTIME_KIND_ORDER.map((rk) => item(rk, RUNTIME_MENU_LABEL[rk], count(rk))) : [item(k, KIND_MENU_LABEL[k], count(k))]))
        }))
    ];
}

/** The menu item `?kind=` selects; no kind is All plugins. */
export const menuCurrent = (kind: string | undefined): string => kind || ALL_ID;

/** How a fix is reached: a page or anchor in the app, or (`external`) the deployment docs. */
export interface AttentionFix {
    readonly label: string;
    readonly href: string;
    readonly external?: boolean;
}

export interface AttentionItem {
    readonly plugin: PluginView;
    readonly status: PluginReadinessStatus;
    /** What it needs, in words ("needs the anthropic-api-key secret"). */
    readonly text: string;
    readonly fix: AttentionFix;
}

/** Where a deployment sets `WORKSPACE_KEK` (runbook §2.4). */
export const KEK_DOCS_HREF = 'https://github.com/andtii/agentic/blob/main/docs/runbook.md#24-generate-and-store-every-secret';

const words = (items: readonly string[] | undefined): string => (items?.length ? items.join(', ') : '');

function attentionOf(p: PluginView, r: PluginReadiness): Omit<AttentionItem, 'plugin' | 'status'> | null {
    const page = pluginHref(p.manifest.id);
    const missing = words(r.missing);
    const plural = (r.missing?.length ?? 0) > 1;
    switch (r.status) {
        case 'needs-secret':
            return { text: missing ? `needs the ${missing} ${plural ? 'secrets' : 'secret'}` : 'needs a key that is not set', fix: { label: 'Add key', href: `${page}#secrets` } };
        case 'needs-machine':
            return { text: 'no paired machine reports this runtime', fix: { label: 'Pair a machine', href: '/pair' } };
        case 'needs-config':
            return { text: missing ? `needs its settings: ${missing}` : 'needs its settings', fix: { label: 'Configure', href: `${page}#config` } };
        case 'needs-grant':
            return { text: missing ? `needs ${missing} granted` : 'needs a permission granted', fix: { label: 'Grant', href: `${page}#granted` } };
        case 'needs-sign-in':
            return { text: 'its sign-in expired', fix: { label: 'Sign in', href: `${page}#account` } };
        case 'no-kek':
            return { text: 'this deployment cannot store keys: WORKSPACE_KEK is not set', fix: { label: 'Deployment docs', href: KEK_DOCS_HREF, external: true } };
        default:
            return null;
    }
}

/** Every enabled plugin that is not ready, with what it needs and its fix, in the list's order. */
export function needsAttention(plugins: readonly PluginView[], readiness: Readiness): AttentionItem[] {
    const out: AttentionItem[] = [];
    for (const p of plugins) {
        const r = readiness[p.manifest.id];
        if (!p.enabled || !r) continue;
        const a = attentionOf(p, r);
        if (a) out.push({ plugin: p, status: r.status, ...a });
    }
    return out;
}

/** The row's kind tag: the runtime kind, a connector's transport (`conduit`, `mcp`), else the plugin kind in words. */
export function rowKind(m: PluginManifest): string {
    const runtime = runtimeKindOf(m);
    if (runtime) return runtime === 'remote' ? 'remote agent' : runtime;
    if (m.kind === 'connector') return isConduitConnector(m) ? 'conduit' : 'mcp';
    return m.kind === 'project-feature' ? 'project feature' : m.kind;
}

/** The note under the memory group: switching is a move, not a toggle. */
export const MEMORY_GROUP_NOTE = 'One is active; switching moves the memories with a fidelity report.';

/**
 * What each memory plugin cannot hold that the others can — the fields its
 * fidelity seam drops (`@agentic/memory`'s flat store: conditions, evidence,
 * superseding and expiry). Kept as data here so the list needs no dry run per
 * row; the Make active confirmation still runs the real one.
 */
const MEMORY_DROPS: Readonly<Record<string, readonly string[]>> = {
    'agentic.memory.flat': ['conditions', 'evidence', 'superseding', 'expiry']
};

/** The mono line under a memory row that is not active: what switching into it drops. */
export function memoryConsequence(p: Pick<PluginView, 'manifest' | 'active'>): string | undefined {
    if (p.manifest.kind !== 'memory' || p.active) return undefined;
    const drops = MEMORY_DROPS[p.manifest.id];
    if (!drops) return undefined;
    return drops.length ? `switching into it drops ${drops.length > 1 ? `${drops.slice(0, -1).join(', ')} and ${drops.at(-1)}` : drops[0]}` : 'switching into it keeps everything';
}

/** How many connector rows the All view shows before "+N more connected". */
export const CONNECTOR_PREVIEW = 2;

/** The Connectors group on the All view: the first few, and how many more there are. */
export function previewConnectors<T>(rows: readonly T[], limit = CONNECTOR_PREVIEW): { readonly shown: readonly T[]; readonly more: number } {
    return { shown: rows.slice(0, limit), more: Math.max(0, rows.length - limit) };
}
