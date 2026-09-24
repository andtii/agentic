/**
 * The Account panel of a conduit connector's page, `/plugins/gmail` (#533,
 * #640; AGT-02, AST-09, PLG-02, PLG-04), board `PluginDetail` → Account:
 *
 * - who it is signed in as and since when — or, not signed in, the status
 *   pill and what to do;
 * - where the OAuth client comes from (the owner's own, stored as secrets
 *   under Keys);
 * - until an account is connected, the redirect URI to paste into the
 *   provider's OAuth client, with Copy;
 * - Connect / Reconnect, a full-page navigation to the Worker's
 *   `/_agentic/connectors/:id/start` (the provider's consent screen, then
 *   back here), and Sign out, a `POST` that revokes at the provider;
 * - what it has that this deployment does not run yet, and the "Testing"
 *   consent screen's 7-day refresh tokens.
 *
 * What agents can do with it is the page's Tools panel (`manifest.tools`).
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
import { connectBlocker, connectionOf, connectionPill, connectionText, connectOutcome, unsupportedOf, type ConnectionState } from './conduit';
import { formatDay, oauthClientText } from './detail-model';

/** The blocker as this page lays it out: the OAuth client's keys are under Keys, below the panel. */
const placed = (blocker: string | undefined): string | undefined => blocker?.replace(/ above first\.$/, ' under Keys first.');

export type ConduitConnectPanelProps =
    /** The connector's name (`Gmail`). */
    & Define.Prop<'name', string, true>
    & Define.Prop<'redirectUri', string, true>
    /** `undefined` while the accounts load. */
    & Define.Prop<'connection', ConnectionState | undefined>
    /** Where the OAuth client comes from (`oauthClientText`). */
    & Define.Prop<'oauthClient', string>
    /** Why Connect cannot run yet. */
    & Define.Prop<'blocker', string>
    & Define.Prop<'unsupported', readonly string[]>
    & Define.Prop<'busy', boolean>
    /** What the last sign-in or sign-out said. */
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
        const blocker = placed(props.blocker);
        return (
            <section id="account" data-plugin-panel="connect" aria-label={`${props.name} account`} data-connection={c?.state ?? 'loading'}>
                <Label>Account</Label>
                <dl data-account-rows>
                    <div data-account-row="signed-in">
                        <dt>Signed in as</dt>
                        <dd data-connect-status>
                            {!c ? <span aria-busy="true">Loading…</span> : null}
                            {pill && c?.state !== 'active' ? <StatusPill status={pill.status} label={pill.label} /> : null}
                            {c?.state === 'active'
                                ? <><span data-connect-text>{c.account.displayName ?? c.account.id}</span><span data-account-meta>connected {formatDay(c.account.createdAt)}</span></>
                                : c ? <span data-connect-text>{connectionText(c, props.name)}</span> : null}
                        </dd>
                    </div>
                    {props.oauthClient ? (
                        <div data-account-row="client">
                            <dt>OAuth client</dt>
                            <dd>{props.oauthClient}</dd>
                        </div>
                    ) : null}
                    {c?.state !== 'active' ? (
                        <div data-account-row="redirect">
                            <dt>Redirect URI</dt>
                            <dd>
                                <div data-command-well data-connect-redirect>
                                    <code>{props.redirectUri}</code>
                                    <Button intent="default" label="Copy redirect URI" onClick={copy}>Copy</Button>
                                </div>
                                <p data-plugin-hint>Add it to your OAuth client’s authorized redirect URIs.</p>
                            </dd>
                        </div>
                    ) : null}
                    <div data-account-row="actions">
                        <dt>Actions</dt>
                        <dd data-connect-actions>
                            {connected
                                ? (
                                    <>
                                        <Button intent={reconnect ? 'primary' : 'default'} disabled={props.busy || !!blocker} onClick={() => emit('connect')}>Reconnect</Button>
                                        <Button intent="default" disabled={props.busy} loading={props.busy} onClick={() => emit('disconnect')}>Sign out</Button>
                                    </>
                                )
                                : <Button intent="primary" icon="link" disabled={props.busy || !!blocker || !c} onClick={() => emit('connect')}>Connect</Button>}
                        </dd>
                    </div>
                </dl>
                {blocker ? <p data-plugin-hint data-connect-blocker>{blocker}</p> : null}
                {props.notice ? <p data-plugin-saved role="status">{props.notice}</p> : null}
                {props.error ? <p data-chat-error role="alert">{props.error}</p> : null}
                {props.unsupported?.length ? <p data-plugin-hint data-connect-unsupported>Not yet: {props.unsupported.join(', ')}.</p> : null}
                <p data-plugin-hint data-connect-testing>
                    While your Google consent screen is in “Testing”, Google issues refresh tokens that expire after 7 days: the account then shows Reconnect. Publish the consent screen to keep a connection longer.
                </p>
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
    /** How Sign out reaches the Worker — `fetch` by default. */
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
            if (!res.ok) throw new Error(`the sign-out was refused (HTTP ${res.status})`);
            const body = (await res.json()) as { revoked?: boolean };
            st.notice = body.revoked === false ? `Signed out here; ${props.plugin.manifest.name} could not be told, so also remove the app from your Google account’s security settings.` : 'Signed out.';
        } catch (e) {
            st.error = e instanceof Error ? e.message : 'the sign-out failed';
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
                oauthClient={oauthClientText(m, props.secretNames)}
                blocker={connectBlocker(props.plugin, props.secretNames, props.hasKek)}
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
