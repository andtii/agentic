/**
 * `/plugins?kind=connector` (#638; PLG-03, OPS-04): the connectors the
 * workspace has added — board `PluginsConnectors`. A filter box, the chips
 * (All, Ready, Needs sign-in), the `Add connector` button, then "CONNECTED · N"
 * over one `PluginRow` per connector: the account or endpoint line, the
 * transport, readiness with an inline Sign in, who picks it, the switch and
 * the link to its page. Remove sits at the row's end and goes through the
 * `plugin-in-use` confirm (`LiveConnectorsView` on the platform).
 *
 * `ConnectorsList` draws and emits; the platform page (`LiveConnectorsView`)
 * and the mock page (`MockConnectorsView`, over `mock/plugins-connectors.ts`)
 * own the state, so both are the same view.
 */
import { component, signal, type Define, type JSXElement } from 'sigx';
import type { Dependents, PluginView } from '@agentic/platform';
import { AgentTile, Button, ConfirmDialog, EmptyState, FormDialog, Label, PluginRow, SearchField, Switch, TextField, type AgentHue } from '@agentic/ui';
import { connectorAccounts, connectorDependents, connectorFacts, connectorPlugins, connectorRecords } from '../../mock/plugins-connectors';
import { dataMode } from '../../data-mode';
import { OpsPage } from '../ops/OpsPage';
import { dependentCount, dependentNames } from '../ops/live';
import { connectorChips, connectorRows, filterConnectorRows, mcpCredentialOf, type ConnectorFilter, type ConnectorRow } from './connectors-model';
import { LiveConnectorsView } from './LiveConnectorsView';
import { dependentsById, pluginHref } from './model';
import { opsAgent } from '../../mock/ops';
import { readinessById } from './readiness';

/** Where `Add connector` goes: its own page (#639). */
export const ADD_CONNECTOR_HREF = '/plugins/connectors/add';

export const CONNECTED_NOTE = 'Each connector signs in once; agents only get it when you add it to their tools';

export type ConnectorsListProps =
    & Define.Prop<'rows', readonly ConnectorRow[], true>
    /** `dependentsAll()` by plugin id; `undefined` while it loads. */
    & Define.Prop<'dependents', Readonly<Record<string, Dependents>>>
    & Define.Prop<'agentOf', (id: string) => { readonly name: string; readonly hue?: AgentHue }, true>
    /** The enable switch of one row; the page holds its state until the Registry answers. */
    & Define.Prop<'toggle', (plugin: PluginView) => JSXElement, true>
    /** A write is in flight: Remove waits. */
    & Define.Prop<'busy', boolean>
    /** Why the last Remove or switch failed, shown above the list. */
    & Define.Prop<'error', string>
    /** The rows are still loading: no empty state yet. */
    & Define.Prop<'loading', boolean>
    /** Offer `Add MCP server` (the MCP form) beside the empty state's pointer at Add connector. */
    & Define.Prop<'onAddMcp', () => void>
    & Define.Event<'signIn', ConnectorRow>
    & Define.Event<'remove', ConnectorRow>;

export const ConnectorsList = component<ConnectorsListProps>(({ props, emit }) => {
    const st = signal<{ filter: ConnectorFilter; query: string }>({ filter: 'all', query: '' });

    const dependentsCell = (id: string): JSXElement => {
        const deps = props.dependents?.[id];
        if (!deps) return <span data-connector-deps="loading">…</span>;
        if (!dependentCount(deps)) return <span data-connector-deps="none">No dependents</span>;
        return (
            <span data-connector-deps title={dependentNames(deps, (a) => props.agentOf(a).name).join('; ')}>
                {deps.agents.map((a) => { const who = props.agentOf(a.id); return <AgentTile key={a.id} name={a.name || who.name} hue={who.hue} size={20} labelled />; })}
                {deps.schedules.length ? <span data-connector-schedules>+{deps.schedules.length}</span> : null}
            </span>
        );
    };

    return () => {
        const all = props.rows;
        const rows = filterConnectorRows(all, st.filter, st.query);
        return (
            <OpsPage
                page="plugins"
                title="Connectors"
                slots={{
                    lead: () => (
                        <div data-connectors-controls>
                            <SearchField model={() => st.query} label="Filter your connectors" placeholder="Filter your connectors" />
                            <div role="group" aria-label="Filter by readiness" data-connector-chips>
                                {connectorChips(all).map((c) => (
                                    <button key={c.id} type="button" data-filter-chip data-chip={c.id} aria-pressed={st.filter === c.id ? 'true' : 'false'} onClick={() => { st.filter = c.id; }}>
                                        <span data-chip-label>{c.label}</span>{' '}<span data-chip-count>{c.count}</span>
                                    </button>
                                ))}
                            </div>
                        </div>
                    ),
                    actions: () => <Button intent="primary" icon="plus" href={ADD_CONNECTOR_HREF}>Add connector</Button>
                }}
            >
                <section data-plugin-connectors aria-label="Connected connectors" aria-busy={props.loading ? 'true' : undefined}>
                    <div data-connectors-label>
                        <Label>Connected · {all.length}</Label>
                        <span data-connectors-note>{CONNECTED_NOTE}</span>
                    </div>
                    {props.error ? <p data-chat-error role="alert">{props.error}</p> : null}
                    {all.length
                        ? rows.length
                            ? (
                                <ul data-connector-rows>
                                    {rows.map((row) => (
                                        <li key={row.id} data-connector-item={row.id}>
                                            <PluginRow
                                                variant="connector"
                                                id={row.id}
                                                name={row.name}
                                                description={row.line}
                                                kind={row.transport}
                                                readiness={row.readiness}
                                                href={pluginHref(row.id)}
                                                slots={{
                                                    // `preventDefault`: a button inside the row's link still follows it in browsers; the slot only stops the bubbling.
                                                    ...(row.signIn ? { fix: () => <Button intent="wait" label={`Sign in to ${row.name}`} onClick={(e: MouseEvent) => { e.preventDefault(); emit('signIn', row); }}>Sign in</Button> } : {}),
                                                    dependents: () => dependentsCell(row.id),
                                                    toggle: () => props.toggle(row.plugin)
                                                }}
                                            />
                                            {/* A connector that ships with the build cannot be removed (the Registry says `builtin`): disable it, or disconnect its account on its page. */}
                                            {row.plugin.builtin ? null : (
                                                <span data-connector-remove>
                                                    <Button intent="icon" icon="trash" label={`Remove ${row.name}`} disabled={props.busy} onClick={() => emit('remove', row)} />
                                                </span>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            )
                            : <p data-plugin-none>No connector matches. Clear the filter to see all {all.length}.</p>
                        : props.loading
                            ? <p data-plugin-none>Loading…</p>
                            : (
                                <EmptyState
                                    variant="generic"
                                    icon="link"
                                    title="No connectors yet"
                                    caption="Add a connector to give agents a service's tools: sign in once, then add it to the agents that should have it."
                                    slots={{
                                        actions: () => (
                                            <>
                                                <Button intent="primary" icon="plus" href={ADD_CONNECTOR_HREF}>Add connector</Button>
                                                {props.onAddMcp ? <Button icon="link" onClick={() => props.onAddMcp?.()}>Add MCP server</Button> : null}
                                            </>
                                        )
                                    }}
                                />
                            )}
                </section>
            </OpsPage>
        );
    };
}, { name: 'ConnectorsList' });

export type McpSignInDialogProps =
    & Define.Model<boolean>
    /** The connector signing in again; `null` closes the dialog. */
    & Define.Prop<'row', ConnectorRow | null>
    & Define.Prop<'busy', boolean>
    /** Why the last sign-in failed. */
    & Define.Prop<'error', string>
    /** The new credential — or `''` for a server that takes none, which is only checked again. */
    & Define.Event<'save', string>
    & Define.Event<'cancel', void>;

/**
 * Sign in to an MCP server again: the MCP form's credential field for the
 * server the row already names (its URL and how it takes the credential stay
 * as they are). The page seals the new value, checks the server with it and
 * records what the check said, so the row reads READY once it answers. The
 * value is dropped the moment it is emitted.
 */
export const McpSignInDialog = component<McpSignInDialogProps>(({ props, emit }) => {
    const st = signal({ value: '' });
    return () => {
        const row = props.row;
        const cred = row ? mcpCredentialOf(row.record) : { auth: 'none' as const };
        const needsValue = cred.auth !== 'none';
        return (
            <FormDialog
                model={props.model}
                title={row ? `Sign in to ${row.name}` : 'Sign in'}
                description={row ? `${row.line}. ${needsValue ? `Paste a new ${cred.auth === 'header' ? `${cred.header} key` : 'token'}: it is sealed in this workspace, never shown again, and the server is checked with it.` : 'This server takes no credential: it is checked again.'}` : undefined}
                submitLabel={needsValue ? 'Sign in' : 'Check again'}
                busy={props.busy}
                onSubmit={() => {
                    if (needsValue && !st.value.trim()) return;
                    const value = st.value.trim();
                    st.value = '';
                    emit('save', value);
                }}
                onCancel={() => { st.value = ''; emit('cancel'); }}
            >
                <div data-mcp-sign-in={row?.id}>
                    {needsValue ? <TextField model={() => st.value} name="connector-secret" label={cred.auth === 'header' ? 'Key' : 'Token'} type="password" required /> : null}
                    {props.error ? <p data-chat-error role="alert">{props.error}</p> : null}
                </div>
            </FormDialog>
        );
    };
}, { name: 'McpSignInDialog' });

export type RemoveConnectorDialogProps =
    & Define.Model<boolean>
    & Define.Prop<'name', string, true>
    & Define.Prop<'dependents', Dependents, true>
    & Define.Prop<'agentName', (id: string) => string, true>
    & Define.Prop<'busy', boolean>
    & Define.Event<'confirm', void>
    & Define.Event<'cancel', void>;

/** The `plugin-in-use` confirm: who still picks it, by name, before anything is removed (#241). */
export const RemoveConnectorDialog = component<RemoveConnectorDialogProps>(({ props, emit }) => () => {
    const names = dependentNames(props.dependents, props.agentName);
    return (
        <ConfirmDialog
            model={props.model}
            title={`Remove ${props.name}?`}
            description="These still pick it. Removed, their new sessions go without its tools and say so. Its credential is deleted with it."
            {...(names.length ? { dependents: names, dependentsLabel: `Depends on it · ${dependentCount(props.dependents)}` } : {})}
            confirmLabel={`Remove ${props.name} anyway`}
            cancelLabel="Keep it"
            busy={props.busy}
            onConfirm={() => emit('confirm')}
            onCancel={() => emit('cancel')}
        />
    );
}, { name: 'RemoveConnectorDialog' });

/**
 * The Connectors view on mock data: `mock/plugins-connectors.ts`, with the
 * switch, Sign in (a conduit connector's goes nowhere here; an MCP one opens
 * the form and reads READY once saved) and Remove held in page state. Remove
 * confirms by name while agents pick the connector, as the Registry would.
 */
export const MockConnectorsView = component(() => {
    const st = signal<{ records: typeof connectorRecords; removed: readonly string[]; enabled: Record<string, boolean>; signingIn: ConnectorRow | null; removing: ConnectorRow | null }>({
        records: connectorRecords,
        removed: [],
        enabled: Object.fromEntries(connectorPlugins.map((p) => [p.manifest.id, p.enabled])),
        signingIn: null,
        removing: null
    });
    const deps = dependentsById(connectorDependents);
    const rows = (): ConnectorRow[] => {
        const plugins = connectorPlugins.filter((p) => !st.removed.includes(p.manifest.id)).map((p) => ({ ...p, enabled: st.enabled[p.manifest.id] ?? p.enabled }));
        return connectorRows(plugins, st.records, connectorAccounts, readinessById(plugins, connectorFacts(st.records)));
    };
    const remove = (row: ConnectorRow, force = false): void => {
        if (row.plugin.builtin) return;
        const d = deps[row.id];
        if (!force && d && dependentCount(d)) {
            st.removing = row;
            return;
        }
        st.removed = [...st.removed, row.id];
        st.removing = null;
    };
    const signIn = (row: ConnectorRow): void => {
        if (row.signIn?.kind === 'mcp') st.signingIn = row;
    };
    const signedIn = (): void => {
        const row = st.signingIn;
        if (row) st.records = st.records.map((r) => (r.id === row.record.id ? { ...r, status: { state: 'ok' as const, checkedAt: r.status.checkedAt ?? 0 } } : r));
        st.signingIn = null;
    };
    return () => {
        const removing = st.removing;
        return (
            <>
                <ConnectorsList
                    rows={rows()}
                    dependents={deps}
                    agentOf={opsAgent}
                    toggle={(p: PluginView) => <Switch label={`Enable ${p.manifest.name}`} hideLabel model={() => st.enabled[p.manifest.id]} onCheckedChange={(v: boolean) => { st.enabled[p.manifest.id] = v; }} />}
                    onSignIn={signIn}
                    onRemove={(row: ConnectorRow) => remove(row)}
                />
                <McpSignInDialog model={() => st.signingIn !== null} row={st.signingIn} onSave={signedIn} onCancel={() => { st.signingIn = null; }} />
                {removing ? (
                    <RemoveConnectorDialog
                        model={() => st.removing !== null}
                        name={removing.name}
                        dependents={deps[removing.id]!}
                        agentName={(id: string) => opsAgent(id).name}
                        onConfirm={() => remove(removing, true)}
                        onCancel={() => { st.removing = null; }}
                    />
                ) : null}
            </>
        );
    };
}, { name: 'MockConnectorsView' });

export const ConnectorsView = component(() => () => (dataMode() === 'live' ? <LiveConnectorsView /> : <MockConnectorsView />));
