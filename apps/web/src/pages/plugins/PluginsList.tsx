import { component, signal, untrack, watch, type Define, type JSXElement } from 'sigx';
import { useRoute, useRouter } from '@sigx/router';
import { isSingleSlot, type PluginReadiness, type PluginReadinessFacts } from '@agentic/core';
import type { Dependents, PluginView } from '@agentic/platform';
import { AgentTile, Button, ConfirmDialog, Icon, PluginRow, ReadinessBadge, SearchField, Switch, type AgentHue } from '@agentic/ui';
import { opsAgent, opsEnvironments, opsPluginFacts } from '../../mock/ops';
import { listPluginDependents, listPlugins } from '../../mock/plugins-list';
import { OpsPage } from '../ops/OpsPage';
import { LinkButton } from '../ops/LinkButton';
import { dependentCount, dependentNames, disableLabel } from '../ops/live';
import { dataMode } from '../../data-mode';
import { LivePlugins } from '../ops/LivePlugins';
import { queryOf } from '../session/files';
import { canActivate, dependentsById, disableDescription, featuresOf, groupByKind, isLastReadyRuntime, needsConfirm, pluginHref, workspaceWideConsequence, type PluginGroup } from './model';
import { ALL_ID, MEMORY_GROUP_NOTE, STATUS_FILTERS, filterPlugins, inCategory, matchPlugin, memoryConsequence, needsAttention, pluginsHref, previewConnectors, rowKind, statusCounts, statusFilterOf, type StatusFilter } from './list-model';
import { readinessById, readinessFacts } from './readiness';

/** The mock workspace's readiness facts: its secrets, and the environments its machines report. */
export const mockPluginFacts = (): PluginReadinessFacts => readinessFacts(opsPluginFacts, opsEnvironments);

/** A mock agent as the plugin views name one. */
export const mockAgentOf = (id: string) => opsAgent(id);

/**
 * A plain left click on an in-app link inside `e.currentTarget` goes through
 * the router instead of reloading the page; a modified click, a new-tab
 * click or an external link is left to the browser.
 */
export function followLink(e: MouseEvent, router: { push(to: string): unknown }): void {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as Element | null)?.closest?.('a[href]');
    if (!a || !(e.currentTarget as Element).contains(a) || a.getAttribute('target')) return;
    const href = a.getAttribute('href') ?? '';
    if (!href.startsWith('/')) return;
    e.preventDefault();
    void router.push(href);
}

export type PluginListViewProps =
    & Define.Prop<'plugins', readonly PluginView[], true>
    /** By plugin id; a plugin without an entry shows no readiness pill yet. */
    & Define.Prop<'readiness', Readonly<Record<string, PluginReadiness>>, true>
    /** `dependentsAll()` by plugin id; `undefined` while it loads. */
    & Define.Prop<'dependents', Readonly<Record<string, Dependents>>>
    /** What a plugin disabled on this visit still leaves referencing it. */
    & Define.Prop<'left', Readonly<Record<string, Dependents>>>
    /** The enable switch of one row: the page draws it, because the page holds its state until the Registry answers. */
    & Define.Prop<'toggle', (plugin: PluginView) => JSXElement, true>
    /** Make a memory or learning plugin the active one (the radio rows' Make active). */
    & Define.Prop<'activate', (plugin: PluginView) => void, true>
    & Define.Prop<'agentOf', (id: string) => { readonly name: string; readonly hue?: AgentHue }, true>
    & Define.Prop<'loading', boolean>
    /** The `?kind=` category. */
    & Define.Prop<'kind', string>
    /** Page actions before Add connector (the live page's Add A2A peer). */
    & Define.Slot<'actions'>
    /** After the list: errors, dialogs, the live page's secrets. */
    & Define.Slot<'default'>;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * `/plugins`' list (#637, board `Plugins`): search (`?q=`), status chips
 * (`?status=`) and Add connector over the needs-attention box and the
 * plugins by group, each a compact `PluginRow` that links to its page.
 * Memory and learning are pick-one radio lists; the Connectors group shows
 * the first two and counts the rest. It draws and emits: the page owns the
 * Registry (or, on mock data, its fixtures), so live and mock are one view.
 */
export const PluginListView = component<PluginListViewProps>(({ props, slots }) => {
    const route = useRoute();
    const router = useRouter();
    // The URL owns the search; `st.q` is the input's draft, and follows the URL
    // when it changes under the view (back/forward across `?kind=`, which keeps it mounted).
    const urlQ = (): string => queryOf(route.query.q) ?? '';
    const st = signal({ q: urlQ() });
    let seen = st.q;
    watch(urlQ, (q) => {
        if (q === seen) return;
        seen = q;
        untrack(() => { if (st.q !== q) st.q = q; });
    });
    const status = (): StatusFilter => statusFilterOf(queryOf(route.query.status));
    const go = (next: { q?: string; status?: StatusFilter }): void => {
        void router.replace(pluginsHref({ kind: props.kind, q: next.q ?? st.q, status: next.status ?? status() }));
    };

    const dependentsCell = (p: PluginView): JSXElement => {
        if (!props.dependents) return <span data-plugin-none>…</span>;
        const deps = props.dependents[p.manifest.id];
        if (deps?.workspaceWide) return <span data-plugin-used data-workspace-wide>Every agent</span>;
        if (!deps || !dependentCount(deps)) return <span data-plugin-none>No dependents</span>;
        return (
            <span data-plugin-used>
                {deps.agents.map((a) => { const who = props.agentOf(a.id); return <span data-plugin-dependent={a.id} data-name={a.name || who.name}><AgentTile name={a.name || who.name} hue={who.hue} size={20} labelled /></span>; })}
                {deps.schedules.length ? <span data-plugin-schedules>{plural(deps.schedules.length, 'schedule')}</span> : null}
            </span>
        );
    };

    const row = (p: PluginView): JSXElement => {
        const id = p.manifest.id;
        const readiness = props.readiness[id];
        if (isSingleSlot(p.manifest.kind)) {
            return (
                <PluginRow
                    key={id}
                    variant="radio"
                    id={id}
                    name={p.manifest.name}
                    version={p.manifest.version}
                    description={p.manifest.description}
                    readiness={readiness}
                    active={p.active === true}
                    consequence={memoryConsequence(p)}
                    href={pluginHref(id)}
                    slots={{ action: () => (canActivate(p) ? <Button intent="default" onClick={(e: MouseEvent) => { e.preventDefault(); props.activate(p); }}>Make active</Button> : readiness ? <ReadinessBadge readiness={readiness} /> : null) }}
                />
            );
        }
        return (
            <PluginRow
                key={id}
                id={id}
                name={p.manifest.name}
                version={p.manifest.version}
                features={featuresOf(p.manifest)}
                description={p.manifest.description}
                kind={rowKind(p.manifest)}
                readiness={readiness}
                href={pluginHref(id)}
                slots={{ dependents: () => dependentsCell(p), toggle: () => props.toggle(p) }}
            />
        );
    };

    const group = (g: PluginGroup): JSXElement => {
        const connectors = g.kind === 'connector';
        // The unfiltered All view never lists every connector: two, then the count and the way to the
        // Connectors view. A category, search or status filter lists every connector that matches.
        const preview = connectors && (!props.kind || props.kind === ALL_ID) && !st.q && status() === 'all';
        const { shown, more } = preview ? previewConnectors(g.plugins) : { shown: g.plugins, more: 0 };
        const note = g.note ?? (g.kind === 'memory' ? MEMORY_GROUP_NOTE : undefined);
        return (
            <section key={g.key} data-plugin-group={g.key} aria-label={g.title}>
                <div data-plugin-group-head>
                    <h2 data-plugin-group-label>{g.title}</h2>
                    {note ? <p data-plugin-group-note>{note}</p> : null}
                    {connectors ? <a data-plugin-group-action href="/plugins/connectors/add" class="ag-link">Add connector</a> : null}
                </div>
                <div data-plugin-rows>
                    {shown.map(row)}
                    {more ? (
                        <div data-plugin-more>
                            <span>+ {more} more connected</span>
                            <a href={pluginsHref({ kind: 'connector' })} class="ag-link">All connectors</a>
                        </div>
                    ) : null}
                </div>
            </section>
        );
    };

    return () => {
        const readiness = props.readiness;
        const inKind = props.plugins.filter((p) => inCategory(p, props.kind, readiness));
        const searched = inKind.filter((p) => matchPlugin(p, st.q));
        const counts = statusCounts(searched, readiness);
        const rows = filterPlugins(props.plugins, readiness, { kind: props.kind, q: st.q, status: status() });
        const attention = needsAttention(inKind, readiness);
        const left = Object.entries(props.left ?? {});
        const nameOf = (id: string): string => props.plugins.find((p) => p.manifest.id === id)?.manifest.name ?? id;
        return (
            <OpsPage
                page="plugins"
                title="Plugins"
                slots={{
                    lead: () => (
                        <div data-plugins-filters>
                            <SearchField label="Search plugins" placeholder="Search plugins, tools and permissions" model={() => st.q} onValueChange={(v: string) => go({ q: v })} />
                            <div data-status-chips role="group" aria-label="Status">
                                {STATUS_FILTERS.map((s) => (
                                    <button type="button" data-status-chip={s.id} aria-pressed={status() === s.id ? 'true' : 'false'} onClick={() => go({ status: s.id })}>
                                        <span>{s.label}</span>
                                        <span data-count>{counts[s.id]}</span>
                                    </button>
                                ))}
                            </div>
                        </div>
                    ),
                    actions: () => (
                        <>
                            {slots.actions?.()}
                            <LinkButton to="/plugins/connectors/add" intent="primary" icon="plus">Add connector</LinkButton>
                        </>
                    )
                }}
            >
                <div data-plugin-list aria-busy={props.loading ? 'true' : undefined} onClick={(e: MouseEvent) => followLink(e, router)}>
                    {attention.length ? (
                        <section data-plugin-attention aria-label="Needs attention">
                            <p data-plugin-attention-title><Icon name="warning" size={15} />{plural(attention.length, 'enabled plugin')} can’t be used yet</p>
                            <ul>
                                {attention.map((a, i) => (
                                    <li data-plugin={a.plugin.manifest.id} data-readiness={a.status}>
                                        <AgentTile name={a.plugin.manifest.name} size={24} />
                                        <a data-plugin-attention-name href={pluginHref(a.plugin.manifest.id)}>{a.plugin.manifest.name}</a>
                                        <span data-plugin-attention-text>{a.text}</span>
                                        {a.fix.external
                                            ? <a data-plugin-fix href={a.fix.href} target="_blank" rel="noopener" class="ag-link">{a.fix.label}</a>
                                            : <Button href={a.fix.href} intent={i === 0 ? 'wait' : 'default'}>{a.fix.label}</Button>}
                                    </li>
                                ))}
                            </ul>
                        </section>
                    ) : null}
                    {left.map(([id, deps]) => (
                        <p data-plugin-left data-plugin={id} role="status">
                            {deps.workspaceWide
                                ? `Disabled ${nameOf(id)}. ${workspaceWideConsequence(props.plugins.find((p) => p.manifest.id === id)?.manifest.kind ?? 'memory')}`
                                : dependentCount(deps)
                                    ? `Disabled ${nameOf(id)}. Still referenced by ${dependentNames(deps, (a) => props.agentOf(a).name).join('; ')} — new use is refused, running work finishes.`
                                    : `Disabled ${nameOf(id)}. Nothing references it.`}
                        </p>
                    ))}
                    {rows.length
                        ? groupByKind(rows).map(group)
                        : <p data-plugin-none data-plugin-empty>{props.plugins.length ? 'No plugins match.' : props.loading ? 'Loading…' : 'No plugins.'}</p>}
                </div>
                {slots.default?.()}
            </OpsPage>
        );
    };
}, { name: 'PluginListView' });

export type PluginsViewProps =
    & Define.Prop<'plugins', readonly PluginView[], true>
    & Define.Prop<'dependents', readonly Dependents[]>
    /** What `pluginReadiness` reads; default: the mock workspace's. */
    & Define.Prop<'facts', PluginReadinessFacts>
    & Define.Prop<'kind', string>;

/**
 * `/plugins` on mock data: the list over `mock/plugins-list.ts`. Turning a
 * switch off on a plugin somebody depends on opens the dialog that lists
 * them by name; the switch stays on until the user confirms. Make active
 * moves the slot at once (the mock has no memories to move).
 */
export const PluginsView = component<PluginsViewProps>(({ props }) => {
    const enabled = signal<Record<string, boolean>>(Object.fromEntries(props.plugins.map(p => [p.manifest.id, p.enabled])));
    const active = signal<Record<string, boolean>>(Object.fromEntries(props.plugins.map(p => [p.manifest.id, p.active === true])));
    const ui = signal<{ confirming: string | null }>({ confirming: null });
    const facts = (): PluginReadinessFacts => props.facts ?? mockPluginFacts();
    const plugins = (): PluginView[] => props.plugins.map(p => ({ ...p, enabled: enabled[p.manifest.id] ?? p.enabled, ...(isSingleSlot(p.manifest.kind) ? { active: active[p.manifest.id] === true } : {}) }));
    const deps = (): Record<string, Dependents> => dependentsById(props.dependents ?? listPluginDependents);

    const toggle = (plugin: PluginView, next: boolean) => {
        const id = plugin.manifest.id;
        if (!next && (needsConfirm(deps()[id]) || isLastReadyRuntime(plugin, readinessById(plugins(), facts()), plugins()))) {
            // Hold the switch on; the dialog decides.
            enabled[id] = true;
            ui.confirming = id;
            return;
        }
        enabled[id] = next;
    };
    const confirmDisable = () => {
        if (ui.confirming) enabled[ui.confirming] = false;
        ui.confirming = null;
    };
    const activate = (plugin: PluginView) => {
        for (const p of props.plugins) if (p.manifest.kind === plugin.manifest.kind) active[p.manifest.id] = p.manifest.id === plugin.manifest.id;
    };

    return () => {
        const rows = plugins();
        const readiness = readinessById(rows, facts());
        const confirming = rows.find(p => p.manifest.id === ui.confirming);
        const confirmingDeps = confirming ? deps()[confirming.manifest.id] : undefined;
        const names = confirmingDeps ? dependentNames(confirmingDeps, id => opsAgent(id).name) : [];
        return (
            <PluginListView
                plugins={rows}
                readiness={readiness}
                dependents={deps()}
                agentOf={mockAgentOf}
                kind={props.kind}
                toggle={(p: PluginView) => <Switch label={`Enable ${p.manifest.name}`} hideLabel model={() => enabled[p.manifest.id]} onCheckedChange={(v: boolean) => toggle(p, v)} />}
                activate={activate}
            >
                {confirming ? (
                    <ConfirmDialog
                        model={() => ui.confirming !== null}
                        title={`Disable ${confirming.manifest.name}?`}
                        description={disableDescription(confirming, confirmingDeps, isLastReadyRuntime(confirming, readiness, rows))}
                        {...(names.length ? { dependents: names, dependentsLabel: `Depends on it · ${dependentCount(confirmingDeps!)}` } : {})}
                        confirmLabel={disableLabel(confirming)}
                        cancelLabel="Keep enabled"
                        onConfirm={confirmDisable}
                        onCancel={() => { ui.confirming = null; }}
                    />
                ) : null}
            </PluginListView>
        );
    };
});

export type PluginsListProps =
    /** The `?kind=` category the menu sets. */
    Define.Prop<'kind', string>;

/** `/plugins`' content: the workspace Registry on the platform (`LivePlugins`, #145, #233), or the mock list. */
export const PluginsList = component<PluginsListProps>(({ props }) => () => (dataMode() === 'live' ? <LivePlugins kind={props.kind} /> : <PluginsView plugins={listPlugins} kind={props.kind} />));
