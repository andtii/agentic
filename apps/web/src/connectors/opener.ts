/**
 * The conduit half of the session's `ConnectorOpener` (#533): one connected
 * account as tools, over the workspace's engine.
 *
 * The router hands ids only (`{ kind: 'conduit', id, pluginId, connector,
 * account }`, #530); the session's `ConnectorOpenContext` says whose
 * workspace it is, which principal the session runs as, and how to open the
 * connector plugin's secrets. The engine is built per open and lives as long
 * as the session: its stores are the workspace's `ConnectorAccounts` as the
 * session's agent principal, so a refresh inside a tool call writes as that
 * session. Tokens stay in the Worker — the model sees tool results only.
 *
 * A missing engine secret means nobody ever connected in this workspace (or
 * the secret was removed): the connector is left out and the agent told
 * where the owner reconnects it.
 */
import { CONNECTOR_ENGINE_SECRET, conduitTools } from '@agentic/connectors';
import type { ConnectorOpenContext, ConnectorOpenInput, OpenedConnector } from '@agentic/platform';
import { workspaceConnectorEngine, type ConnectorHttp } from './engine';
import { connectorPluginPage, connectorRedirectUri } from './paths';

export interface ConduitOpenerOptions {
    /** The deployment's public origin (`APP_ORIGIN`), read at open. Absent: a placeholder — a session never begins a sign-in. */
    readonly origin?: () => string | undefined;
    /** `fetch` replacement for the provider (tests). */
    readonly http?: ConnectorHttp;
}

/** The origin a session's engine is built with when the deployment names none: never sent, only parsed. */
const PLACEHOLDER_ORIGIN = 'http://localhost';

export function conduitOpener(options: ConduitOpenerOptions = {}): (input: Extract<ConnectorOpenInput, { kind: 'conduit' }>, context?: ConnectorOpenContext) => Promise<OpenedConnector> {
    return async (input, context) => {
        if (!context) throw new Error('this session cannot open conduit connectors (no workspace context)');
        const engineSecret = await context.secret(CONNECTOR_ENGINE_SECRET, input.pluginId);
        if (!engineSecret) throw new Error(`its account cannot be opened: connect it again (${connectorPluginPage(input.pluginId)})`);
        const engine = workspaceConnectorEngine({
            workspaceId: context.workspaceId,
            principal: context.principal,
            secret: (name) => context.secret(name, input.pluginId),
            engineSecret,
            redirectUri: connectorRedirectUri(options.origin?.() ?? PLACEHOLDER_ORIGIN),
            ...(options.http ? { http: options.http } : {})
        });
        const opened = await conduitTools(engine, { id: input.id, connector: input.connector, account: input.account, owner: context.workspaceId });
        return opened as unknown as OpenedConnector;
    };
}
