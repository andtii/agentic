/**
 * The MCP servers of a workspace on `/plugins` (#241; PLG-03, AST-09): each
 * connector with where it is, its last check and the tools it lists, the
 * "Add MCP server" dialog, and Remove. Removing goes through
 * `Registry.remove`, which refuses with `plugin-in-use` while agents or
 * schedules pick the server; the page then names them and removes only when
 * the person confirms (`force`); the connector's own credential is deleted
 * with it. The plugin's own card, switch and page are
 * the catalogue's, like any other plugin.
 */
import { component, signal, type Define } from 'sigx';
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
import type { ConnectorRecord, Dependents } from '@agentic/platform';
import { Button, ConfirmDialog, Label, StatusPill, Tag } from '@agentic/ui';
import type { ActorDefs } from '../../actors/defs';
import { connectorWhere, dependentCount, dependentNames } from '../ops/live';
import { AddConnectorDialog, type AddConnectorRequest } from './AddConnectorDialog';
import { addConnector, connectorStatusLabel, type ConnectorDraft, type ConnectorProbe } from './connector';
import { isInUse, registryErrorText } from './model';

export type LiveConnectorsProps =
    & Define.Prop<'defs', Pick<ActorDefs, 'Registry'>, true>
    /** The Registry's key. */
    & Define.Prop<'registryKey', string, true>
    /** Plugin ids the Registry lists — a new server's id must not collide. */
    & Define.Prop<'pluginIds', readonly string[], true>
    & Define.Prop<'agentName', (id: string) => string, true>
    /** A connector plugin was added or removed — the page re-reads its dependents. */
    & Define.Prop<'onChanged', () => void>
    /** The dialog's probe; tests hand in one over a fake server. */
    & Define.Prop<'probe', (draft: ConnectorDraft) => Promise<ConnectorProbe>>;

interface Removing {
    readonly connector: ConnectorRecord;
    readonly dependents: Dependents;
}

export const LiveConnectors = component<LiveConnectorsProps>(({ props }) => {
    const connectors = useActorState(props.defs.Registry, () => [props.registryKey, 'connectors'] as const, { live: true });
    const st = signal<{ adding: boolean; busy: boolean; addError: string; error: string; removing: Removing | null }>({ adding: false, busy: false, addError: '', error: '', removing: null });
    const registry = () => actor(props.defs.Registry, props.registryKey);

    const add = async ({ draft, probe }: AddConnectorRequest): Promise<void> => {
        st.busy = true;
        st.addError = '';
        try {
            await addConnector(registry(), draft, probe);
            st.adding = false;
            props.onChanged?.();
        } catch (e) {
            st.addError = registryErrorText(e);
        } finally {
            st.busy = false;
        }
    };

    const remove = async (connector: ConnectorRecord, force = false): Promise<void> => {
        st.busy = true;
        st.error = '';
        try {
            await registry().remove(connector.pluginId, force ? { force: true } : {});
            // Its credential goes with it, unless another connector still reads the same secret.
            const others = (connectors.value ?? []).filter((c) => c.pluginId !== connector.pluginId);
            for (const name of connector.secrets ?? []) if (!others.some((c) => c.secrets?.includes(name))) await registry().deleteSecret(name);
            st.removing = null;
            props.onChanged?.();
        } catch (e) {
            if (!force && isInUse(e)) {
                // Say who picks it, by name, before anything is removed.
                const dependents = await registry().dependents(connector.pluginId).catch(() => null);
                if (dependents) st.removing = { connector, dependents };
                else st.error = registryErrorText(e);
            } else st.error = registryErrorText(e);
        } finally {
            st.busy = false;
        }
    };

    return () => {
        // A conduit connector (Gmail, #533) is set up and connected on its own plugin page, not here.
        const list = connectors.value?.filter((c) => c.transport !== 'conduit');
        const removing = st.removing;
        const names = removing ? dependentNames(removing.dependents, props.agentName) : [];
        return (
            <section data-plugin-connectors aria-label="Connectors">
                <div data-connectors-head>
                    <Label>MCP connectors</Label>
                    <Button icon="plus" onClick={() => { st.addError = ''; st.adding = true; }}>Add MCP server</Button>
                </div>
                {list?.length
                    ? (
                        <ul data-connector-list>
                            {list.map((c) => (
                                <li key={c.id} data-connector={c.id}>
                                    <span data-connector-name>{c.id}</span>
                                    <Tag>{c.transport}</Tag>
                                    <code data-mono data-dim>{connectorWhere(c)}</code>
                                    <StatusPill status={c.status.state === 'ok' ? 'online' : c.status.state === 'error' ? 'error' : 'unknown'} label={connectorStatusLabel(c)} />
                                    <span data-connector-plugin>plugin {c.pluginId}</span>
                                    {c.transport === 'stdio' ? <span data-connector-needs>needs a machine — coming</span> : null}
                                    {c.secrets?.length ? <span data-connector-secrets>secrets: {c.secrets.join(', ')}</span> : null}
                                    {c.status.error ? <span data-connector-error>{c.status.error}</span> : null}
                                    {c.tools.length ? <ul data-connector-tools>{c.tools.map((t) => <li key={t}><code data-mono>{t}</code></li>)}</ul> : null}
                                    <Button icon="trash" disabled={st.busy} onClick={() => { void remove(c); }} label={`Remove ${c.id}`}>Remove</Button>
                                </li>
                            ))}
                        </ul>
                    )
                    : <p data-plugin-none>{list ? 'No connectors configured. Add an MCP server to give agents its tools.' : 'Loading…'}</p>}
                {st.error ? <p data-chat-error role="alert">{st.error}</p> : null}

                <AddConnectorDialog
                    model={() => st.adding}
                    busy={st.busy}
                    taken={new Set(props.pluginIds)}
                    error={st.addError}
                    {...(props.probe ? { probe: props.probe } : {})}
                    onAdd={(request: AddConnectorRequest) => { void add(request); }}
                    onCancel={() => { st.adding = false; }}
                />
                {removing ? (
                    <ConfirmDialog
                        model={() => st.removing !== null}
                        title={`Remove ${removing.connector.id}?`}
                        description="These still pick it. Removed, their new sessions go without its tools and say so. Its credential is deleted with it."
                        {...(names.length ? { dependents: names, dependentsLabel: `Depends on it · ${dependentCount(removing.dependents)}` } : {})}
                        confirmLabel={`Remove ${removing.connector.id} anyway`}
                        cancelLabel="Keep it"
                        busy={st.busy}
                        onConfirm={() => { void remove(removing.connector, true); }}
                        onCancel={() => { st.removing = null; }}
                    />
                ) : null}
            </section>
        );
    };
}, { name: 'LiveConnectors' });
