/**
 * A workspace's conduit engine (#533, architecture §9 "connectors that sign
 * in"): `createConnectorEngine` of `@agentic/connectors` with every port the
 * workspace's own.
 *
 * - **Stores**: the `ConnectorAccounts` actor of the workspace
 *   (`{ws}:connector-accounts`, #532), called as the principal the engine is
 *   built for — the owner on the sign-in routes, the session's agent
 *   principal for a tool call (a token refresh inside it writes as that
 *   session).
 * - **OAuth client**: `clientFromSecrets` over the connector plugin's own
 *   `client-id` / `client-secret` Registry secrets, opened per lookup.
 * - **Secret**: `connector-engine-secret`, a random per-workspace value kept
 *   as a Registry secret. It signs OAuth state and keys the credential
 *   cipher, so one workspace's sealed accounts never open with another's
 *   key. `ensureEngineSecret` generates it on the first Connect (the owner
 *   only: `setSecret` is owner-only); a session only ever reads it.
 * - **Redirect URI**: `<origin>/_agentic/connectors/callback`. An engine
 *   built for a session never begins a sign-in, so its redirect URI is never
 *   sent anywhere; conduit only needs it to be a valid URL.
 */
import type { Principal, WorkspaceId } from '@agentic/core';
import { clientFromSecrets, createConnectorEngine, CONNECTOR_ENGINE_SECRET, type ConnectorEngine } from '@agentic/connectors';
import { ConnectorAccounts, asPrincipal, connectorAccountStores, connectorAccountsKey, type ConnectorAccountsClient } from '@agentic/platform';
import { actor } from '@sigx/actors';

/** conduit's `HttpClient`: a `fetch` replacement (tests hand in a fake provider). */
export type ConnectorHttp = (request: Request) => Promise<Response>;

export interface WorkspaceEngineInput {
    readonly workspaceId: WorkspaceId;
    /** Who the account store is called as. */
    readonly principal: Principal;
    /** A secret of the connector plugin (`Registry.openSecret(name, pluginId)`); `undefined` when not set. */
    secret(name: string): Promise<string | undefined>;
    /** The workspace's engine secret (`ensureEngineSecret`, or read back for a session). */
    readonly engineSecret: string;
    readonly redirectUri: string;
    readonly http?: ConnectorHttp;
}

/** The workspace's conduit engine, as `principal`. Cheap: nothing is read until a call needs it. */
export function workspaceConnectorEngine(input: WorkspaceEngineInput): ConnectorEngine {
    const client = actor(ConnectorAccounts, connectorAccountsKey(input.workspaceId)).with({ context: asPrincipal(input.principal) }) as unknown as ConnectorAccountsClient;
    return createConnectorEngine({
        secret: input.engineSecret,
        ...connectorAccountStores(client),
        clients: clientFromSecrets((name) => input.secret(name)),
        redirectUri: input.redirectUri,
        ...(input.http ? { http: input.http } : {})
    });
}

/** 32 random bytes, base64url: 43 characters, over conduit's 32-character floor. */
export function newEngineSecret(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A Registry refusal for a secret that is not set — by `code`, or by message when the class did not survive a hop. */
export function isSecretMissing(error: unknown): boolean {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'secret-missing') return true;
    return error instanceof Error && /\[registry\] no secret "/.test(error.message);
}

/** The slice of a Registry client (as the owner) the connector routes call. */
export interface ConnectorRegistry {
    get(id: string): Promise<{ readonly enabled: boolean } | null>;
    getConnector(id: string): Promise<{ readonly id: string; readonly pluginId: string; readonly transport: string; readonly connector?: string; readonly account?: string } | null>;
    putConnector(input: { readonly id: string; readonly pluginId: string; readonly transport: 'conduit'; readonly connector: string; readonly account?: string }): Promise<unknown>;
    openSecret(name: string, pluginId: string): Promise<string>;
    setSecret(name: string, value: string): Promise<unknown>;
}

/** A connector plugin's secret, `undefined` when it is not set. Any other refusal (plugin off, not granted) throws. */
export async function openPluginSecret(registry: Pick<ConnectorRegistry, 'openSecret'>, name: string, pluginId: string): Promise<string | undefined> {
    try {
        return await registry.openSecret(name, pluginId);
    } catch (e) {
        if (isSecretMissing(e)) return undefined;
        throw e;
    }
}

/** The workspace's engine secret, generated and sealed in the Registry the first time (the owner's call). */
export async function ensureEngineSecret(registry: Pick<ConnectorRegistry, 'openSecret' | 'setSecret'>, pluginId: string): Promise<string> {
    const existing = await openPluginSecret(registry, CONNECTOR_ENGINE_SECRET, pluginId);
    if (existing !== undefined) return existing;
    const secret = newEngineSecret();
    await registry.setSecret(CONNECTOR_ENGINE_SECRET, secret);
    return secret;
}
