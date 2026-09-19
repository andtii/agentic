/**
 * The `/plugins` catalogue (#233): every plugin of the build by kind, on the
 * kit's `PluginCard` — readiness, the enable switch, what was granted and
 * who depends on it. It draws and emits; the page owns the Registry (or, in
 * mock mode, its fixtures), so the live and the mock page are the same view.
 */
import { component, type Define, type JSXElement } from 'sigx';
import { Link } from '@sigx/router';
import type { PluginReadiness } from '@agentic/core';
import type { Dependents, PluginView } from '@agentic/platform';
import { AgentTile, Icon, Label, PluginCard, type AgentHue } from '@agentic/ui';
import { dependentCount, dependentNames } from '../ops/live';
import { featuresOf, groupByKind, kindLabel, pluginHref, ungranted, workspaceWideConsequence } from './model';

export type PluginCatalogueProps =
    & Define.Prop<'plugins', readonly PluginView[], true>
    /** By plugin id; a plugin without an entry shows no readiness pill yet. */
    & Define.Prop<'readiness', Readonly<Record<string, PluginReadiness>>>
    /** `dependentsAll()` by plugin id; `undefined` while it loads. */
    & Define.Prop<'dependents', Readonly<Record<string, Dependents>>>
    /** What a plugin disabled on this visit still leaves referencing it. */
    & Define.Prop<'left', Readonly<Record<string, Dependents>>>
    /** The enable switch of one card. The page draws it, because the page holds its state until the Registry answers. */
    & Define.Prop<'toggle', (plugin: PluginView) => JSXElement, true>
    & Define.Prop<'agentOf', (id: string) => { readonly name: string; readonly hue?: AgentHue }, true>
    & Define.Prop<'loading', boolean>;

export const PluginCatalogue = component<PluginCatalogueProps>(({ props }) => () => {
    const agentName = (id: string): string => props.agentOf(id).name;
    return (
        <div data-plugin-catalogue aria-busy={props.loading ? 'true' : undefined}>
            {groupByKind(props.plugins).map((group) => (
                <section key={group.key} data-plugin-group={group.key} aria-label={group.title}>
                    <Label>{group.title}</Label>
                    {group.note ? <p data-plugin-group-note>{group.note}</p> : null}
                    <div data-plugin-grid>
                        {group.plugins.map((p) => {
                            const id = p.manifest.id;
                            const deps = props.dependents?.[id];
                            const left = props.left?.[id];
                            const missing = ungranted(p);
                            return (
                                <PluginCard
                                    key={id}
                                    id={id}
                                    name={p.manifest.name}
                                    kind={p.manifest.kind}
                                    kindLabel={kindLabel(p.manifest)}
                                    features={featuresOf(p.manifest)}
                                    version={p.manifest.version}
                                    description={p.manifest.description}
                                    readiness={props.readiness?.[id]}
                                    active={p.active === true}
                                    slots={{
                                        toggle: () => props.toggle(p),
                                        meta: () =>
                                            deps?.workspaceWide
                                                ? <span data-plugin-used data-workspace-wide>Used by every agent</span>
                                                : deps && dependentCount(deps)
                                                    ? (
                                                        <span data-plugin-used>
                                                            Used by {deps.agents.map((a) => { const who = props.agentOf(a.id); return <AgentTile name={a.name || who.name} hue={who.hue} size={20} labelled />; })}
                                                            {deps.schedules.length ? <span data-plugin-schedules>{deps.schedules.length} {deps.schedules.length === 1 ? 'schedule' : 'schedules'}</span> : null}
                                                        </span>
                                                    )
                                                    : <span data-plugin-none>{deps ? 'No dependents' : 'Looking up dependents…'}</span>,
                                        configure: () => <Link to={pluginHref(id)} class="ag-link">Configure</Link>,
                                        default: () => (
                                            <>
                                                <div data-plugin-section>
                                                    <Label>Granted</Label>
                                                    {p.grantedPermissions.length
                                                        ? <ul data-plugin-granted>{p.grantedPermissions.map((g) => <li><Icon name="check" size={14} /><span>{g}</span></li>)}</ul>
                                                        : <span data-plugin-none>nothing</span>}
                                                </div>
                                                {missing.length ? (
                                                    <div data-plugin-section>
                                                        <Label>Declared, not granted</Label>
                                                        <span data-plugin-unsupported>{missing.join(', ')}</span>
                                                    </div>
                                                ) : null}
                                                {left ? (
                                                    <p data-plugin-left role="status">
                                                        {left.workspaceWide
                                                            ? `Disabled. ${workspaceWideConsequence(p.manifest.kind)}`
                                                            : dependentCount(left)
                                                                ? `Disabled. Still referenced by ${dependentNames(left, agentName).join('; ')} — new use is refused, running work finishes.`
                                                                : 'Disabled. Nothing references it.'}
                                                    </p>
                                                ) : null}
                                            </>
                                        )
                                    }}
                                />
                            );
                        })}
                    </div>
                </section>
            ))}
        </div>
    );
}, { name: 'PluginCatalogue' });
