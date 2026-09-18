import { component, signal, type Define } from 'sigx';
import { Link } from '@sigx/router';
import { AgentTile, Button, ConfirmDialog, Icon, Label, Switch, Tag } from '@agentic/ui';
import { disableConsequence, opsAgent, opsPlugins, type OpsPlugin } from '../mock/ops';
import { OpsPage } from './ops/OpsPage';
import { defineTopbar } from '../components/topbar';
import { dataMode } from '../data-mode';
import { LivePlugins } from './ops/LivePlugins';

export type PluginsViewProps = Define.Prop<'plugins', readonly OpsPlugin[], true>;

/** A dependent, by name, for the confirm dialog: "Forge — default environment · 1 active session". */
export function dependentName(d: OpsPlugin['dependents'][number]): string {
    const who = d.agentId ? opsAgent(d.agentId).name : (d.schedule ?? '');
    return `${who} — ${d.reason}`;
}

/**
 * `/plugins` — three-column cards: name and version, kind tag,
 * description, granted permissions, declared unsupported operations
 * (PLG-09), dependents as tiles, enable switch. Turning a switch off on a
 * plugin with dependents opens the dialog that lists them by name and
 * states the consequence ("Disable and stop 2 sessions"); the switch stays
 * on until the user confirms.
 */
defineTopbar('plugins', () => ({ actions: () => <Button intent="default" icon="plus">Add MCP connector</Button> }));

export const PluginsView = component<PluginsViewProps>(({ props }) => {
    const enabled = signal<Record<string, boolean>>(Object.fromEntries(props.plugins.map(p => [p.id, p.enabled])));
    const ui = signal<{ confirming: string | null }>({ confirming: null });

    const toggle = (plugin: OpsPlugin, next: boolean) => {
        if (!next && plugin.dependents.length) {
            // Hold the switch on; the dialog decides.
            enabled[plugin.id] = true;
            ui.confirming = plugin.id;
            return;
        }
        enabled[plugin.id] = next;
    };
    const confirmDisable = () => {
        if (ui.confirming) enabled[ui.confirming] = false;
        ui.confirming = null;
    };

    return () => {
        const confirming = props.plugins.find(p => p.id === ui.confirming);
        return (
            <OpsPage page="plugins" title="Plugins">
                <div data-plugin-grid>
                    {props.plugins.map(p => (
                        <article data-plugin-card data-enabled={enabled[p.id] ? '' : undefined} aria-label={p.name}>
                            <header data-plugin-head>
                                <span data-plugin-name>
                                    <span>{p.name}</span>
                                    <span data-plugin-version>{p.version}</span>
                                </span>
                                <Switch label={`Enable ${p.name}`} hideLabel model={() => enabled[p.id]} onCheckedChange={(v: boolean) => toggle(p, v)} />
                            </header>
                            <Tag>{p.kind}</Tag>
                            <p data-plugin-description>{p.description}</p>
                            <div data-plugin-section>
                                <Label>Granted</Label>
                                {p.granted.length
                                    ? <ul data-plugin-granted>{p.granted.map(g => <li><Icon name="check" size={14} /><span>{g}</span></li>)}</ul>
                                    : <span data-plugin-none>nothing</span>}
                            </div>
                            {p.unsupported.length ? (
                                <div data-plugin-section>
                                    <Label>Declared unsupported</Label>
                                    <span data-plugin-unsupported>{p.unsupported.join(', ')}</span>
                                </div>
                            ) : null}
                            <footer data-plugin-foot>
                                {p.usedBy.length
                                    ? <span data-plugin-used>Used by {p.usedBy.map(id => <AgentTile name={opsAgent(id).name} hue={opsAgent(id).hue} size={20} labelled />)}</span>
                                    : <span data-plugin-none>No dependents</span>}
                                <Link to="/plugins" class="ag-link">Configure</Link>
                            </footer>
                        </article>
                    ))}
                </div>
                {confirming ? (
                    <ConfirmDialog
                        model={() => ui.confirming !== null}
                        title={`Disable ${confirming.name}?`}
                        description="These stop being able to start work. Nothing is deleted, and nothing is moved to another runtime."
                        dependents={confirming.dependents.map(dependentName)}
                        dependentsLabel={`Depends on it · ${confirming.dependents.length}`}
                        confirmLabel={disableConsequence(confirming)}
                        cancelLabel="Keep enabled"
                        onConfirm={confirmDisable}
                        onCancel={() => { ui.confirming = null; }}
                    />
                ) : null}
            </OpsPage>
        );
    };
});

/** `/plugins`: the workspace Registry on the platform (`LivePlugins`, #145), or the mock cards. */
export const Plugins = component(() => () => (dataMode() === 'live' ? <LivePlugins /> : <PluginsView plugins={opsPlugins} />));
