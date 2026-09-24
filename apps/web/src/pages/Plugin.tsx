import { component, signal, type Define } from 'sigx';
import { Link, useRoute, useRouter } from '@sigx/router';
import { runtimeKindOf, type PermissionScope, type PluginReadinessFacts, type ToolMode } from '@agentic/core';
import type { Dependents, PluginView } from '@agentic/platform';
import { EmptyState, Switch } from '@agentic/ui';
import { opsGmailAccount, opsHarness, opsMachines, opsPluginDependents, opsPlugins } from '../mock/ops';
import { mockConnectorRecords, withMockTools } from '../mock/plugins-detail';
import { connectorRedirectUri } from '../connectors/paths';
import { pageOrigin } from './machines/LivePair';
import { ConduitConnectPanel } from './plugins/ConduitConnect';
import { connectBlocker, isConduitConnector, managedSecretsOf, unsupportedOf, type ConnectionState } from './plugins/conduit';
import { endpointOf, oauthClientText, pluginHead, pluginTrail, toolRows, transportOf } from './plugins/detail-model';
import { runtimeOnMachine } from './machines/harness';
import { defineTopbar, routeId } from '../components/topbar';
import { dataMode } from '../data-mode';
import { OpsPage } from './ops/OpsPage';
import { mockAgentOf, mockPluginFacts } from './Plugins';
import { LivePlugin } from './plugins/LivePlugin';
import { PluginDetail, type SecretWrite, type ToolPolicyWrite } from './plugins/PluginDetail';
import { readinessById } from './plugins/readiness';
import { RuntimeMachineRow, RuntimeMachines } from './plugins/RuntimeMachines';

/**
 * The trail names the plugin (#640): Plugins › Connectors › Gmail for a connector, Plugins › Memory otherwise. Live,
 * what the page published for THIS plugin (`pluginHead`); mock, the sample workspace's. The id until either is known.
 */
defineTopbar('plugin', (route) => {
    const id = routeId(route);
    if (dataMode() === 'live') return pluginTrail(id, route.path, pluginHead.value?.id === id ? pluginHead.value : undefined);
    const m = opsPlugins.find((p) => p.manifest.id === id)?.manifest;
    return pluginTrail(id, route.path, m ? { id, name: m.name, kind: m.kind } : undefined);
});

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
    const st = signal<{ enabled: boolean; config: Record<string, unknown>; granted: PermissionScope[]; secretNames: string[]; active: boolean | undefined; saved: boolean; connection: ConnectionState; policy: Record<string, ToolMode> }>({
        enabled: props.plugin.enabled,
        config: { ...props.plugin.config },
        granted: [...props.plugin.grantedPermissions],
        secretNames: [...base.secretNames],
        active: props.plugin.active,
        saved: false,
        connection: { state: 'active', account: opsGmailAccount } as ConnectionState,
        policy: {}
    });
    const record = mockConnectorRecords.find((r) => r.pluginId === props.plugin.manifest.id);
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
                    managedSecrets={managedSecretsOf(p.manifest)}
                    transport={transportOf(p.manifest, mockConnectorRecords)}
                    tools={toolRows(p.manifest, st.policy, {}, record?.tools)}
                    endpoint={p.manifest.kind === 'connector' && !isConduitConnector(p.manifest) ? endpointOf(p, record, st.secretNames) : undefined}
                    account={() => (isConduitConnector(p.manifest) ? (
                        // A conduit connector (#533): Connect flips the mock account; nothing leaves the page.
                        <ConduitConnectPanel
                            name={p.manifest.name}
                            redirectUri={connectorRedirectUri(pageOrigin())}
                            connection={st.connection}
                            oauthClient={oauthClientText(p.manifest, st.secretNames)}
                            blocker={connectBlocker(p, st.secretNames, base.hasKek)}
                            unsupported={unsupportedOf(p.manifest)}
                            onConnect={() => { st.connection = { state: 'active', account: opsGmailAccount }; }}
                            onDisconnect={() => { st.connection = { state: 'not-connected' }; }}
                        />
                    ) : null)}
                    extra={() => (runtimeKindOf(p.manifest) === 'harness' ? (
                        <RuntimeMachines name={p.manifest.name}>
                            {opsMachines.map((m) => <RuntimeMachineRow machine={runtimeOnMachine(id, { machineId: m.id, name: m.name, online: m.online, ...opsHarness(m.id) })} />)}
                        </RuntimeMachines>
                    ) : null)}
                    toggle={() => <Switch label={`Enable ${p.manifest.name}`} hideLabel model={() => st.enabled} />}
                    onConfigure={(config: Record<string, unknown>) => { st.config = config; st.saved = true; }}
                    onSaveSecret={(w: SecretWrite) => { if (!st.secretNames.includes(w.name)) st.secretNames = [...st.secretNames, w.name]; }}
                    onRemoveSecret={(name: string) => { st.secretNames = st.secretNames.filter(n => n !== name); }}
                    onToolPolicy={(w: ToolPolicyWrite) => { st.policy = { ...st.policy, [w.tool]: w.mode }; }}
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
        return <PluginPageView key={id} plugin={withMockTools(plugin)} dependents={opsPluginDependents.find(d => d.pluginId === id)} />;
    };
});
