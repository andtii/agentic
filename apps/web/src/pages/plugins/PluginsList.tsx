import { component, signal, type Define } from 'sigx';
import type { PluginReadinessFacts } from '@agentic/core';
import type { Dependents, PluginView } from '@agentic/platform';
import { ConfirmDialog, Switch } from '@agentic/ui';
import { opsAgent, opsEnvironments, opsPluginDependents, opsPluginFacts, opsPlugins } from '../../mock/ops';
import { OpsPage } from '../ops/OpsPage';
import { dependentCount, dependentNames, disableLabel } from '../ops/live';
import { dataMode } from '../../data-mode';
import { LivePlugins } from '../ops/LivePlugins';
import { PluginCatalogue } from './PluginCatalogue';
import { dependentsById, disableDescription, isLastReadyRuntime, needsConfirm } from './model';
import { readinessById, readinessFacts } from './readiness';

export type PluginsViewProps =
    & Define.Prop<'plugins', readonly PluginView[], true>
    & Define.Prop<'dependents', readonly Dependents[]>
    /** What `pluginReadiness` reads; default: the mock workspace's. */
    & Define.Prop<'facts', PluginReadinessFacts>;

/** The mock workspace's readiness facts: its secrets, and the environments its machines report. */
export const mockPluginFacts = (): PluginReadinessFacts => readinessFacts(opsPluginFacts, opsEnvironments);

/** A mock agent as the plugin views name one. */
export const mockAgentOf = (id: string) => opsAgent(id);

/**
 * `/plugins` — the build's plugins by kind on three-column cards: name and
 * version, kind tag, readiness, description, granted permissions,
 * dependents as tiles, the enable switch and the link to the plugin's page.
 * Turning a switch off on a plugin somebody depends on opens the dialog that
 * lists them by name; the switch stays on until the user confirms. The same
 * `PluginCatalogue` the live page draws, over `mock/ops.ts`.
 */
export const PluginsView = component<PluginsViewProps>(({ props }) => {
    const enabled = signal<Record<string, boolean>>(Object.fromEntries(props.plugins.map(p => [p.manifest.id, p.enabled])));
    const ui = signal<{ confirming: string | null }>({ confirming: null });
    const facts = (): PluginReadinessFacts => props.facts ?? mockPluginFacts();
    const plugins = (): PluginView[] => props.plugins.map(p => ({ ...p, enabled: enabled[p.manifest.id] ?? p.enabled }));
    const deps = (): Record<string, Dependents> => dependentsById(props.dependents ?? opsPluginDependents);

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

    return () => {
        const rows = plugins();
        const readiness = readinessById(rows, facts());
        const confirming = rows.find(p => p.manifest.id === ui.confirming);
        const confirmingDeps = confirming ? deps()[confirming.manifest.id] : undefined;
        const names = confirmingDeps ? dependentNames(confirmingDeps, id => opsAgent(id).name) : [];
        return (
            <OpsPage page="plugins" title="Plugins">
                <PluginCatalogue
                    plugins={rows}
                    readiness={readiness}
                    dependents={deps()}
                    agentOf={mockAgentOf}
                    toggle={(p: PluginView) => <Switch label={`Enable ${p.manifest.name}`} hideLabel model={() => enabled[p.manifest.id]} onCheckedChange={(v: boolean) => toggle(p, v)} />}
                />
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
            </OpsPage>
        );
    };
});

export type PluginsListProps =
    /** The `?kind=` filter the redesign's menu sets (#637); today's catalogue lists every kind. */
    Define.Prop<'kind', string>;

/** `/plugins`' content: the workspace Registry on the platform (`LivePlugins`, #145, #233), or the mock catalogue. */
export const PluginsList = component<PluginsListProps>(() => () => (dataMode() === 'live' ? <LivePlugins /> : <PluginsView plugins={opsPlugins} />));
