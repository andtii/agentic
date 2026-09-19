/**
 * `/plugins` on the platform (#145, #233): every plugin of the build by
 * kind, from ONE `Registry.overview()` (live) and ONE `dependentsAll()` —
 * readiness from core's `pluginReadiness` over the overview and the
 * workspace's live environments (PLG-02/03). Secrets are listed by NAME
 * only (PLG-04 — no read returns a value); a plugin's own page sets them.
 * The switch is `Registry.enable` / `disable` (`usePluginSwitches`, AC-13).
 * MCP servers are added, tested and removed in `LiveConnectors` (#241).
 */
import { component, useData, useHead } from 'sigx';
import { actor } from '@sigx/actors';
import type { Dependents } from '@agentic/platform';
import { EmptyState, Icon, Label } from '@agentic/ui';
import { useActorDefs, useViewer } from '../../actors/defs';
import { registryKeyOf } from '../../actors/keys';
import { useAgentDirectory } from '../chat/directory';
import { LiveConnectors } from '../plugins/LiveConnectors';
import { PluginCatalogue } from '../plugins/PluginCatalogue';
import { dependentsById } from '../plugins/model';
import { useWorkspaceReadiness } from '../plugins/readiness';
import { usePluginSwitches } from '../plugins/switches';
import { OpsPage } from './OpsPage';

export const LivePlugins = component(() => {
    useHead({ title: 'Plugins' });
    const defs = useActorDefs();
    const viewer = useViewer()();
    const agents = useAgentDirectory(defs, viewer);
    const key = (): string | null => (viewer.workspaceId ? registryKeyOf(viewer.workspaceId) : null);
    const ready = useWorkspaceReadiness(defs, viewer);
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
                {signedOut
                    ? <EmptyState variant="generic" title="Sign in to see your plugins" caption="Plugins are set up per workspace." />
                    : overview && !rows.length
                        ? <EmptyState variant="generic" title="No plugins yet" caption="The runtimes, memory and learning a deployment ships appear here by themselves, ready to configure. This deployment lists none." />
                        : <PluginCatalogue plugins={rows} readiness={ready.byId()} dependents={usedBy.value ?? undefined} left={switches.left()} agentOf={agents.lookup} toggle={switches.switchFor} loading={ready.loading} />}

                {viewer.workspaceId ? (
                    <LiveConnectors
                        defs={defs}
                        registryKey={registryKeyOf(viewer.workspaceId)}
                        pluginIds={rows.map((p) => p.manifest.id)}
                        agentName={(id: string) => agents.lookup(id).name}
                        onChanged={() => { if (usedBy.hasValue) void usedBy.refresh(); }}
                    />
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
