/**
 * `/plugins` on the platform (#145, #233, #637): the workspace's plugins as
 * the list draws them (`PluginListView`), from ONE `Registry.overview()`
 * (live) and ONE `dependentsAll()` — readiness from core's `pluginReadiness`
 * over the overview and the workspace's live environments (PLG-02/03).
 * The switch is `Registry.enable` / `disable` (`usePluginSwitches`, AC-13);
 * Make active on a memory or learning row is `useMemorySwitch` (a memory
 * plugin shows the dry run first, #243). Secrets are listed by NAME only
 * (PLG-04 — no read returns a value); a plugin's own page sets them. MCP
 * servers are added, tested and removed in the Connectors view (`?kind=connector`).
 */
import { component, signal, useData, useHead, type Define } from 'sigx';
import { actor } from '@sigx/actors';
import type { Dependents, PluginView, SlotKind } from '@agentic/platform';
import { EmptyState, ErrorNote, Icon, Label } from '@agentic/ui';
import { useActorDefs, useViewer } from '../../actors/defs';
import { registryKeyOf } from '../../actors/keys';
import { useAgentDirectory } from '../chat/directory';
import { AddA2aPeer } from '../plugins/AddA2aPeer';
import { PluginListView } from '../plugins/PluginsList';
import { dependentsById, registryErrorText } from '../plugins/model';
import { useWorkspaceReadiness } from '../plugins/readiness';
import { usePluginSwitches } from '../plugins/switches';
import { useMemorySwitch } from '../plugins/useMemorySwitch';
import { OpsPage } from './OpsPage';

export const LivePlugins = component<Define.Prop<'kind', string>>(({ props }) => {
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
    const refresh = (): void => { if (usedBy.hasValue) void usedBy.refresh(); };
    const switches = usePluginSwitches({
        defs,
        key,
        plugins: () => ready.overview()?.plugins ?? [],
        readiness: () => ready.byId(),
        agentName: (id) => agents.lookup(id).name,
        onChanged: refresh
    });
    // Make active: one Registry call at a time, its refusal on the page's error line.
    const act = signal({ busy: false, error: '' });
    const run = async (call: (key: string) => Promise<unknown>): Promise<void> => {
        const k = key();
        if (!k || act.busy) return;
        act.busy = true;
        act.error = '';
        try {
            await call(k);
        } catch (e) {
            act.error = registryErrorText(e);
        } finally {
            act.busy = false;
        }
    };
    const memory = useMemorySwitch({
        defs,
        run,
        busy: () => act.busy,
        nameOf: (id) => ready.overview()?.plugins.find((p) => p.manifest.id === id)?.manifest.name ?? id,
        agentName: (id) => agents.lookup(id).name,
        onActivated: refresh
    });

    return () => {
        const overview = ready.overview();
        const rows = overview?.plugins ?? [];
        const signedOut = !viewer.pending && !viewer.workspaceId;
        const error = switches.error() || act.error;
        if (signedOut) {
            return (
                <OpsPage page="plugins" title="Plugins">
                    <EmptyState variant="generic" title="Sign in to see your plugins" caption="Plugins are set up per workspace." />
                </OpsPage>
            );
        }
        if (overview && !rows.length) {
            return (
                <OpsPage page="plugins" title="Plugins">
                    <EmptyState variant="generic" title="No plugins yet" caption="The runtimes, memory and learning a deployment ships appear here by themselves, ready to configure. This deployment lists none." />
                </OpsPage>
            );
        }
        return (
            <PluginListView
                plugins={rows}
                readiness={ready.byId()}
                dependents={usedBy.value ?? undefined}
                left={switches.left()}
                agentOf={agents.lookup}
                toggle={switches.switchFor}
                activate={(p: PluginView) => { void memory.activate(p.manifest.kind as SlotKind, p.manifest.id); }}
                loading={ready.loading}
                kind={props.kind}
                slots={{ actions: () => (viewer.workspaceId ? <AddA2aPeer defs={defs} registryKey={key()} taken={rows.map((p) => p.manifest.id)} /> : null) }}
            >
                {/* Settings does not list the workspace's secrets, so they stay here, by name. */}
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

                {error ? <ErrorNote data-chat-error="">{error}</ErrorNote> : null}
                {switches.dialog()}
                {memory.dialog()}
            </PluginListView>
        );
    };
});
