/**
 * The sign-in panel of a conduit connector's page, `/plugins/gmail` (#533;
 * AGT-02, AGT-09, AST-09, PLG-02, PLG-04). Drawn under the plugin's keys
 * (the OAuth client id and secret, `PluginDetail`'s own secret fields):
 *
 * - the redirect URI to paste into the provider's OAuth client, with Copy;
 * - the account's status — connected as whom, or needs reconnecting;
 * - Connect / Reconnect, a full-page navigation to the Worker's
 *   `/_agentic/connectors/:id/start` (the provider's consent screen, then
 *   back here), and Disconnect, a `POST` that revokes at the provider;
 * - what agents can do with it (AGT-09), and what it has that this
 *   deployment does not run yet;
 * - the "Testing" consent screen's 7-day refresh tokens.
 *
 * Tokens never reach this page: it reads the account summaries of the
 * workspace's `ConnectorAccounts` and the connector record, ids only.
 */
import { component, signal, type Define, type JSXElement } from 'sigx';
import { useActorState } from '@sigx/actors/app';
import type { PluginView } from '@agentic/platform';
import { Button, Label, StatusPill } from '@agentic/ui';
import type { ActorDefs } from '../../actors/defs';
import { connectorAccountsKeyOf, registryKeyOf } from '../../actors/keys';
import { connectorDisconnectPath, connectorRedirectUri, connectorStartPath } from '../../connectors/paths';
import { pageOrigin } from '../machines/LivePair';
import { connectBlocker, connectionOf, connectionPill, connectionText, connectOutcome, operationsOf, unsupportedOf, type ConnectionState, type OperationRow } from './conduit';

export type ConduitConnectPanelProps =
    /** The connector's name (`Gmail`). */
    & Define.Prop<'name', string, true>
    & Define.Prop<'redirectUri', string, true>
    /** `undefined` while the accounts load. */
    & Define.Prop<'connection', ConnectionState | undefined>
    /** Why Connect cannot run yet. */
    & Define.Prop<'blocker', string>
    & Define.Prop<'operations', readonly OperationRow[], true>
    & Define.Prop<'unsupported', readonly string[]>
    & Define.Prop<'busy', boolean>
    /** What the last sign-in or disconnect said. */
    & Define.Prop<'notice', string>
    & Define.Prop<'error', string>
    & Define.Event<'connect', void>
    & Define.Event<'disconnect', void>;

export const ConduitConnectPanel = component<ConduitConnectPanelProps>(({ props, emit }) => {
    // The clipboard can refuse (permissions, insecure context); a refused copy is not an error the page reports.
    const copy = (): void => { void navigator.clipboard?.writeText(props.redirectUri).catch(() => {}); };
    return (): JSXElement => {
        const c = props.connection;
        const pill = c ? connectionPill(c) : null;
        const connected = c !== undefined && c.state !== 'not-connected';
        const reconnect = c?.state === 'needs-reauth' || c?.state === 'missing';
        return (
            <section data-plugin-panel="connect" aria-label={`${props.name} account`} data-connection={c?.state ?? 'loading'}>
                <Label>Account</Label>

                <p data-plugin-hint>Add this redirect URI to your OAuth client’s authorized redirect URIs, then save the client ID and secret above.</p>
                <div data-command-well data-connect-redirect>
                    <code>{props.redirectUri}</code>
                    <Button intent="default" label="Copy redirect URI" onClick={copy}>Copy</Button>
                </div>

                <div data-connect-status>
                    {pill ? <StatusPill status={pill.status} label={pill.label} /> : <span aria-busy="true">Loading…</span>}
                    {c ? <span data-connect-text>{connectionText(c, props.name)}</span> : null}
                </div>

                <div data-connect-actions>
                    {connected
                        ? (
                            <>
                                <Button intent={reconnect ? 'primary' : 'default'} disabled={props.busy || !!props.blocker} onClick={() => emit('connect')}>Reconnect</Button>
                                <Button intent="danger" disabled={props.busy} loading={props.busy} onClick={() => emit('disconnect')}>Disconnect</Button>
                            </>
                        )
                        : <Button intent="primary" icon="link" disabled={props.busy || !!props.blocker || !c} onClick={() => emit('connect')}>Connect</Button>}
                </div>
                {props.blocker ? <p data-plugin-hint data-connect-blocker>{props.blocker}</p> : null}
                {props.notice ? <p data-plugin-saved role="status">{props.notice}</p> : null}
                {props.error ? <p data-chat-error role="alert">{props.error}</p> : null}

                <p data-plugin-hint data-connect-testing>
                    While your Google consent screen is in “Testing”, Google issues refresh tokens that expire after 7 days: the account then shows Reconnect. Publish the consent screen to keep a connection longer.
                </p>

                <Label>What agents can do</Label>
                <p data-plugin-hint>An agent you give {props.name} to gets each of these as a tool. Reading is ruled as a read; sending, replying, labelling and trashing go through the agent’s approval rules like any other network or destructive action.</p>
                <ul data-connect-operations>
                    {props.operations.map((op) => <li key={op.id} data-operation={op.id}><span>{op.label}</span> <code data-mono data-dim>{op.id}</code></li>)}
                </ul>
                {props.unsupported?.length ? <p data-plugin-hint data-connect-unsupported>Not yet: {props.unsupported.join(', ')}.</p> : null}
            </section>
        );
    };
}, { name: 'ConduitConnectPanel' });

export type LiveConduitConnectProps =
    & Define.Prop<'plugin', PluginView, true>
    & Define.Prop<'workspaceId', string, true>
    & Define.Prop<'secretNames', readonly string[], true>
    & Define.Prop<'hasKek', boolean, true>
    & Define.Prop<'defs', Pick<ActorDefs, 'Registry' | 'ConnectorAccounts'>, true>
    /** The page's query: what the sign-in routes said when they sent the owner back. */
    & Define.Prop<'query', Readonly<Record<string, unknown>>>
    /** Where Connect navigates — the browser by default; tests record it. */
    & Define.Prop<'navigate', (href: string) => void>
    /** How Disconnect reaches the Worker — `fetch` by default. */
    & Define.Prop<'post', (path: string) => Promise<Response>>;

export const LiveConduitConnect = component<LiveConduitConnectProps>(({ props }) => {
    const connectors = useActorState(props.defs.Registry, () => [registryKeyOf(props.workspaceId), 'connectors'] as const, { live: true });
    const accounts = useActorState(props.defs.ConnectorAccounts, () => [connectorAccountsKeyOf(props.workspaceId), 'accounts'] as const, { live: true });
    const st = signal({ busy: false, notice: '', error: '' });
    const outcome = connectOutcome(props.query ?? {});

    const connect = (): void => {
        const href = connectorStartPath(props.plugin.manifest.id);
        if (props.navigate) props.navigate(href);
        else location.assign(href);
    };

    const disconnect = async (): Promise<void> => {
        if (st.busy) return;
        st.busy = true;
        st.error = '';
        st.notice = '';
        try {
            const path = connectorDisconnectPath(props.plugin.manifest.id);
            const res = await (props.post ? props.post(path) : fetch(path, { method: 'POST', credentials: 'same-origin' }));
            if (!res.ok) throw new Error(`the disconnect was refused (HTTP ${res.status})`);
            const body = (await res.json()) as { revoked?: boolean };
            st.notice = body.revoked === false ? `Disconnected here; ${props.plugin.manifest.name} could not be told, so also remove the app from your Google account’s security settings.` : 'Disconnected.';
        } catch (e) {
            st.error = e instanceof Error ? e.message : 'the disconnect failed';
        } finally {
            st.busy = false;
        }
    };

    return (): JSXElement => {
        const m = props.plugin.manifest;
        const record = connectors.value?.find((c) => c.id === m.id);
        const connection = connectors.value ? connectionOf(record, accounts.value ?? undefined) : undefined;
        return (
            <ConduitConnectPanel
                name={m.name}
                redirectUri={connectorRedirectUri(pageOrigin())}
                connection={connection}
                blocker={connectBlocker(props.plugin, props.secretNames, props.hasKek)}
                operations={operationsOf(m)}
                unsupported={unsupportedOf(m)}
                busy={st.busy}
                notice={st.notice || (outcome.connected ? `${m.name} is connected.` : '')}
                error={st.error || (outcome.error ? `Connecting failed: ${outcome.error}` : '')}
                onConnect={connect}
                onDisconnect={() => { void disconnect(); }}
            />
        );
    };
}, { name: 'LiveConduitConnect' });
