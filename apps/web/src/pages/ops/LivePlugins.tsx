/**
 * `/plugins` on the platform (#145, #233): every plugin of the build by
 * kind, from ONE `Registry.overview()` (live) and ONE `dependentsAll()` —
 * readiness from core's `pluginReadiness` over the overview and the
 * workspace's live environments (PLG-02/03). Secrets are listed by NAME
 * only (PLG-04 — no read returns a value); a plugin's own page sets them.
 * The switch is `Registry.enable` / `disable` (`usePluginSwitches`, AC-13).
 */
import { component, useData, useHead } from 'sigx';
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
import type { Dependents } from '@agentic/platform';
import { EmptyState, Icon, Label, StatusPill, Tag } from '@agentic/ui';
import { useActorDefs, useViewer } from '../../actors/defs';
import { registryKeyOf } from '../../actors/keys';
import { useAgentDirectory } from '../chat/directory';
import { AddA2aPeer } from '../plugins/AddA2aPeer';
import { PluginCatalogue } from '../plugins/PluginCatalogue';
import { dependentsById } from '../plugins/model';
import { useWorkspaceReadiness } from '../plugins/readiness';
import { usePluginSwitches } from '../plugins/switches';
import { connectorWhere } from './live';
import { OpsPage } from './OpsPage';

export const LivePlugins = component(() => {
    useHead({ title: 'Plugins' });
    const defs = useActorDefs();
    const viewer = useViewer()();
    const agents = useAgentDirectory(defs, viewer);
    const key = (): string | null => (viewer.workspaceId ? registryKeyOf(viewer.workspaceId) : null);
    const ready = useWorkspaceReadiness(defs, viewer);
    const connectors = useActorState(defs.Registry, () => { const k = key(); return k && ([k, 'connectors'] as const); }, { live: true });
    // Who uses each plugin — one read for all of them (the Registry walks the Workspace, its agents and schedules once).
    const usedBy = useData(
        () => {
            const k = key();
            const ids = ready.overview()?.plugins.map((p) => p.manifest.id);
            return k && ids ? (['dependents-all', k, ...ids] as const) : false;
        },
        async (k): Promise<Record<string, Dependents>> => dependentsById(await actor(defs.Registry, (k as readonly string[])[1]!).dependentsAll())
    );
    const switches = usePluginSwitches({
        defs,
        key,
        plugins: () => ready.overview()?.plugins ?? [],
        readiness: () => ready.byId(),
        agentName: (id) => agents.lookup(id).name,
        onChanged: () => { if (usedBy.hasValue) void usedBy.refresh(); }
    });

    return () => {
        const overview = ready.overview();
        const rows = overview?.plugins ?? [];
        const signedOut = !viewer.pending && !viewer.workspaceId;
        return (
            <OpsPage page="plugins" title="Plugins">
                {viewer.workspaceId ? <AddA2aPeer defs={defs} registryKey={key()} taken={rows.map((p) => p.manifest.id)} /> : null}
                {signedOut
                    ? <EmptyState variant="generic" title="Sign in to see your plugins" caption="Plugins are set up per workspace." />
                    : overview && !rows.length
                        ? <EmptyState variant="generic" title="No plugins yet" caption="The runtimes, memory and learning a deployment ships appear here by themselves, ready to configure. This deployment lists none." />
                        : <PluginCatalogue plugins={rows} readiness={ready.byId()} dependents={usedBy.value ?? undefined} left={switches.left()} agentOf={agents.lookup} toggle={switches.switchFor} loading={ready.loading} />}

                {viewer.workspaceId ? (
                    <section data-plugin-connectors aria-label="Connectors">
                        <Label>MCP connectors</Label>
                        {connectors.value?.length
                            ? (
                                <ul data-connector-list>
                                    {connectors.value.map((c) => (
                                        <li data-connector={c.id}>
                                            <span data-connector-name>{c.id}</span>
                                            <Tag>{c.transport}</Tag>
                                            <code data-mono data-dim>{connectorWhere(c)}</code>
                                            <StatusPill status={c.status.state === 'ok' ? 'online' : c.status.state === 'error' ? 'error' : 'unknown'} label={c.status.state === 'ok' ? `${c.tools.length} ${c.tools.length === 1 ? 'tool' : 'tools'}` : c.status.state === 'error' ? 'ERROR' : 'UNCHECKED'} />
                                            <span data-connector-plugin>plugin {c.pluginId}</span>
                                            {c.secrets?.length ? <span data-connector-secrets>secrets: {c.secrets.join(', ')}</span> : null}
                                            {c.status.error ? <span data-connector-error>{c.status.error}</span> : null}
                                        </li>
                                    ))}
                                </ul>
                            )
                            : <p data-plugin-none>{connectors.value ? 'No connectors configured.' : 'Loading…'}</p>}
                    </section>
                ) : null}

                {viewer.workspaceId ? (
                    <section data-plugin-secrets aria-label="Secrets">
                        <Label>Secrets</Label>
                        {overview?.secretNames.length
                            ? (
                                <ul data-secret-list>
                                    {overview.secretNames.map((name) => (
                                        <li data-secret={name}>
                                            <Icon name="key" size={15} />
                                            <span data-secret-name>{name}</span>
                                            <span data-secret-masked>••••••••</span>
                                        </li>
                                    ))}
                                </ul>
                            )
                            : <p data-plugin-none>{overview ? 'No secrets stored. A plugin\'s own page sets the keys it needs; values are sealed under the workspace key and never shown.' : 'Loading…'}</p>}
                    </section>
                ) : null}

                {switches.error() ? <p data-chat-error role="alert">{switches.error()}</p> : null}
                {switches.dialog()}
            </OpsPage>
        );
    };
});
