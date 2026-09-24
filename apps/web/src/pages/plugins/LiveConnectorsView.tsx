/**
 * The Connectors view on the platform (#638; PLG-03, OPS-04): the Registry's
 * plugins and connector records and the workspace's connector account
 * summaries, all live, drawn by `ConnectorsList`. Readiness is the page's
 * `useWorkspaceReadiness`, so an MCP server whose token was refused, or a
 * conduit account whose refresh was, reads NEEDS SIGN-IN with Sign in beside
 * it: a conduit connector goes to its sign-in route, an MCP connector opens
 * the MCP sign-in form, which seals the new credential, checks the server
 * with it and records the answer. The switch is `usePluginSwitches`.
 *
 * Remove is ported from the old connector list (#241): `Registry.remove` refuses
 * with `plugin-in-use` while agents or schedules pick the connector; the page
 * then names them and removes only when the person confirms (`force`). Its
 * credential goes with it unless another connector still reads it.
 */
import { component, signal, useData, type Define } from 'sigx';
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
import type { Dependents } from '@agentic/platform';
import { EmptyState } from '@agentic/ui';
import { useActorDefs, useViewer } from '../../actors/defs';
import { connectorAccountsKeyOf, registryKeyOf } from '../../actors/keys';
import { useAgentDirectory } from '../chat/directory';
import { OpsPage } from '../ops/OpsPage';
import { AddConnectorDialog, type AddConnectorRequest } from './AddConnectorDialog';
import { addConnector, probeConnector, type ConnectorDraft, type ConnectorProbe } from './connector';
import { connectorRows, mcpCredentialOf, mcpSignInDraft, type ConnectorRow } from './connectors-model';
import { ConnectorsList, McpSignInDialog, RemoveConnectorDialog } from './ConnectorsView';
import { dependentsById, isInUse, registryErrorText } from './model';
import { useWorkspaceReadiness } from './readiness';
import { usePluginSwitches } from './switches';

export type LiveConnectorsViewProps =
    /** Where a conduit Sign in navigates — the browser by default; tests record it. */
    & Define.Prop<'navigate', (href: string) => void>
    /** The MCP check; tests hand in one over a fake server. */
    & Define.Prop<'probe', (draft: ConnectorDraft) => Promise<ConnectorProbe>>;

interface Removing {
    readonly row: ConnectorRow;
    readonly dependents: Dependents;
}

export const LiveConnectorsView = component<LiveConnectorsViewProps>(({ props }) => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const agents = useAgentDirectory(defs, viewer);
    const ready = useWorkspaceReadiness(defs, viewer);
    const key = (): string | null => (viewer.workspaceId ? registryKeyOf(viewer.workspaceId) : null);
    const records = useActorState(defs.Registry, () => { const k = key(); return k && ([k, 'connectors'] as const); }, { live: true });
    const accounts = useActorState(defs.ConnectorAccounts, () => { const ws = viewer.workspaceId; return ws && ([connectorAccountsKeyOf(ws), 'accounts'] as const); }, { live: true });
    // Who picks each connector — one read for all of them, as the catalogue does.
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
    const st = signal<{ busy: boolean; error: string; signingIn: ConnectorRow | null; signInError: string; removing: Removing | null; adding: boolean; addError: string }>({
        busy: false, error: '', signingIn: null, signInError: '', removing: null, adding: false, addError: ''
    });
    const registry = () => actor(defs.Registry, key()!);

    const rows = (): ConnectorRow[] => connectorRows(ready.overview()?.plugins ?? [], records.value ?? [], accounts.value ?? undefined, ready.byId());

    const signIn = (row: ConnectorRow): void => {
        if (row.signIn?.kind === 'conduit') {
            if (props.navigate) props.navigate(row.signIn.href);
            else location.assign(row.signIn.href);
            return;
        }
        st.signInError = '';
        st.signingIn = row;
    };

    const saveSignIn = async (value: string): Promise<void> => {
        const row = st.signingIn;
        if (!row || !key()) return;
        st.busy = true;
        st.signInError = '';
        try {
            const cred = mcpCredentialOf(row.record);
            if (cred.secret && value) await registry().setSecret(cred.secret, value);
            if (row.record.transport === 'stdio') {
                // The daemon spawns it: the next session checks it, the browser cannot.
                await registry().setConnectorStatus(row.record.id, { state: 'unknown' });
                st.signingIn = null;
                return;
            }
            const probe = await (props.probe ?? probeConnector)(mcpSignInDraft(row.record, value));
            await registry().setConnectorStatus(row.record.id, probe.ok ? { state: 'ok' } : { state: 'error', error: probe.error }, probe.ok ? probe.tools : undefined);
            if (probe.ok) st.signingIn = null;
            else st.signInError = `The server still refused it: ${probe.error}`;
        } catch (e) {
            st.signInError = registryErrorText(e);
        } finally {
            st.busy = false;
        }
    };

    const remove = async (row: ConnectorRow, force = false): Promise<void> => {
        if (!key()) return;
        const connector = row.record;
        st.busy = true;
        st.error = '';
        try {
            await registry().remove(connector.pluginId, force ? { force: true } : {});
            // Its credential goes with it, unless another connector still reads the same secret.
            const others = (records.value ?? []).filter((c) => c.pluginId !== connector.pluginId);
            for (const name of connector.secrets ?? []) if (!others.some((c) => c.secrets?.includes(name))) await registry().deleteSecret(name);
            st.removing = null;
            refresh();
        } catch (e) {
            if (!force && isInUse(e)) {
                // Say who picks it, by name, before anything is removed.
                const dependents = await registry().dependents(connector.pluginId).catch(() => null);
                if (dependents) st.removing = { row, dependents };
                else st.error = registryErrorText(e);
            } else st.error = registryErrorText(e);
        } finally {
            st.busy = false;
        }
    };

    const add = async ({ draft, probe }: AddConnectorRequest): Promise<void> => {
        if (!key()) return;
        st.busy = true;
        st.addError = '';
        try {
            await addConnector(registry(), draft, probe);
            st.adding = false;
            refresh();
        } catch (e) {
            st.addError = registryErrorText(e);
        } finally {
            st.busy = false;
        }
    };

    return () => {
        if (!viewer.pending && !viewer.workspaceId) {
            return (
                <OpsPage page="plugins" title="Connectors">
                    <EmptyState variant="generic" title="Sign in to see your plugins" caption="Plugins are set up per workspace." />
                </OpsPage>
            );
        }
        const removing = st.removing;
        return (
            <>
                <ConnectorsList
                    rows={rows()}
                    dependents={usedBy.value ?? undefined}
                    agentOf={agents.lookup}
                    toggle={switches.switchFor}
                    busy={st.busy}
                    loading={!ready.overview() || !records.value}
                    onAddMcp={() => { st.addError = ''; st.adding = true; }}
                    onSignIn={signIn}
                    error={st.error || switches.error() || undefined}
                    onRemove={(row: ConnectorRow) => { void remove(row); }}
                />
                <McpSignInDialog
                    model={() => st.signingIn !== null}
                    row={st.signingIn}
                    busy={st.busy}
                    error={st.signInError}
                    onSave={(value: string) => { void saveSignIn(value); }}
                    onCancel={() => { st.signingIn = null; }}
                />
                <AddConnectorDialog
                    model={() => st.adding}
                    busy={st.busy}
                    taken={new Set((ready.overview()?.plugins ?? []).map((p) => p.manifest.id))}
                    error={st.addError}
                    {...(props.probe ? { probe: props.probe } : {})}
                    onAdd={(request: AddConnectorRequest) => { void add(request); }}
                    onCancel={() => { st.adding = false; }}
                />
                {removing ? (
                    <RemoveConnectorDialog
                        model={() => st.removing !== null}
                        name={removing.row.name}
                        dependents={removing.dependents}
                        agentName={(id: string) => agents.lookup(id).name}
                        busy={st.busy}
                        onConfirm={() => { void remove(removing.row, true); }}
                        onCancel={() => { st.removing = null; }}
                    />
                ) : null}
                {switches.dialog()}
            </>
        );
    };
}, { name: 'LiveConnectorsView' });
