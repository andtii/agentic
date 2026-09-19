import { component, signal, type Define } from 'sigx';
import { Link, useRoute, useRouter } from '@sigx/router';
import type { PermissionScope, PluginReadinessFacts } from '@agentic/core';
import type { Dependents, PluginView } from '@agentic/platform';
import { EmptyState, Switch } from '@agentic/ui';
import { opsPluginDependents, opsPlugins } from '../mock/ops';
import { defineTopbar, routeId } from '../components/topbar';
import { dataMode } from '../data-mode';
import { OpsPage } from './ops/OpsPage';
import { mockAgentOf, mockPluginFacts } from './Plugins';
import { LivePlugin } from './plugins/LivePlugin';
import { PluginDetail, type SecretWrite } from './plugins/PluginDetail';
import { readinessById } from './plugins/readiness';

/** The breadcrumb names the plugin by its id until the page knows better — the id is what a person typed or followed. */
defineTopbar('plugin', (route) => ({ crumb: routeId(route) }));

export type PluginPageViewProps =
    & Define.Prop<'plugin', PluginView, true>
    & Define.Prop<'dependents', Dependents>
    & Define.Prop<'facts', PluginReadinessFacts>;

/**
 * `/plugins/:id` over `mock/ops.ts`: the same `PluginDetail` the live page
 * draws. Every change lands in this page's own copy — a saved setting, a
 * granted scope, a key marked as set (its value is dropped on the spot).
 */
export const PluginPageView = component<PluginPageViewProps>(({ props }) => {
    const router = useRouter();
    const base = props.facts ?? mockPluginFacts();
    const st = signal<{ enabled: boolean; config: Record<string, unknown>; granted: PermissionScope[]; secretNames: string[]; active: boolean | undefined; saved: boolean }>({
        enabled: props.plugin.enabled,
        config: { ...props.plugin.config },
        granted: [...props.plugin.grantedPermissions],
        secretNames: [...base.secretNames],
        active: props.plugin.active,
        saved: false
    });
    const current = (): PluginView => ({ ...props.plugin, enabled: st.enabled, config: st.config, grantedPermissions: st.granted, ...(st.active === undefined ? {} : { active: st.active }) });

    return () => {
        const p = current();
        const id = p.manifest.id;
        const readiness = readinessById([p], { ...base, secretNames: st.secretNames })[id];
        return (
            <OpsPage page="plugin" title={p.manifest.name}>
                <PluginDetail
                    plugin={p}
                    readiness={readiness}
                    dependents={props.dependents}
                    secretNames={st.secretNames}
                    status={{ saved: st.saved }}
                    agentOf={mockAgentOf}
                    toggle={() => <Switch label={`Enable ${p.manifest.name}`} hideLabel model={() => st.enabled} />}
                    onConfigure={(config: Record<string, unknown>) => { st.config = config; st.saved = true; }}
                    onSaveSecret={(w: SecretWrite) => { if (!st.secretNames.includes(w.name)) st.secretNames = [...st.secretNames, w.name]; }}
                    onRemoveSecret={(name: string) => { st.secretNames = st.secretNames.filter(n => n !== name); }}
                    onGrant={(scope: PermissionScope) => { st.granted = [...new Set([...st.granted, scope])]; }}
                    onRevoke={(scope: PermissionScope) => { st.granted = st.granted.filter(s => s !== scope); }}
                    onActivate={() => { st.active = true; }}
                    onRemove={() => { void router.push('/plugins'); }}
                />
            </OpsPage>
        );
    };
});

/** `/plugins/:id`: the plugin out of the workspace Registry (`LivePlugin`, #233), or out of the mock catalogue. */
export const Plugin = component(() => {
    const route = useRoute();
    return () => {
        const id = String(route.params.id);
        if (dataMode() === 'live') return <LivePlugin id={id} />;
        const plugin = opsPlugins.find(p => p.manifest.id === id);
        if (!plugin) {
            return (
                <OpsPage page="plugin" title="Plugin">
                    <EmptyState variant="generic" title={`No plugin with id ${id}`} caption="It may have been removed, or this deployment does not ship it." slots={{ actions: () => <Link to="/plugins">All plugins</Link> }} />
                </OpsPage>
            );
        }
        return <PluginPageView key={id} plugin={plugin} dependents={opsPluginDependents.find(d => d.pluginId === id)} />;
    };
});
