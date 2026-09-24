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
 *   `<pluginId>-client-id` / `<pluginId>-client-secret` Registry secrets
 *   (#548), opened per lookup.
 * - **Secret**: `connector-engine-secret`, a random per-workspace value kept
 *   as a Registry secret, shared by every conduit connector plugin. It signs OAuth state and keys the credential
 *   cipher, so one workspace's sealed accounts never open with another's
 *   key. `ensureEngineSecret` generates it on the first Connect (the owner
 *   only: `setSecret` is owner-only); a session only ever reads it.
 * - **Redirect URI**: `<origin>/_agentic/connectors/callback`. An engine
 *   built for a session never begins a sign-in, so its redirect URI is never
 *   sent anywhere; conduit only needs it to be a valid URL.
 */
import type { PermissionScope, Principal, WorkspaceId } from '@agentic/core';
import { clientFromSecrets, createConnectorEngine, CONNECTOR_ENGINE_SECRET, type ConnectorEngine } from '@agentic/connectors';
import { ConnectorAccounts, asPrincipal, connectorAccountStores, connectorAccountsKey, type ConnectorAccountsClient } from '@agentic/platform';
import { actor } from '@sigx/actors';

/** conduit's `HttpClient`: a `fetch` replacement (tests hand in a fake provider). */
export type ConnectorHttp = (request: Request) => Promise<Response>;

export interface WorkspaceEngineInput {
    readonly workspaceId: WorkspaceId;
    /** Who the account store is called as. */
    readonly principal: Principal;
    /** The connector plugin whose OAuth client signs in. */
    readonly pluginId: string;
    /** A secret of the connector plugin (`Registry.openSecret(name, pluginId)`); `undefined` when not set. */
    secret(name: string): Promise<string | undefined>;
    /** The workspace's engine secret (`ensureEngineSecret`, or read back for a session). */
    readonly engineSecret: string;
    readonly redirectUri: string;
    readonly http?: ConnectorHttp;
    /** The hosts of the connector plugin's granted `network:` scopes (#642): a session's engine reaches these only. Absent: no allowlist. */
    readonly allowedHosts?: readonly string[];
}

/** The workspace's conduit engine, as `principal`. Cheap: nothing is read until a call needs it. */
export function workspaceConnectorEngine(input: WorkspaceEngineInput): ConnectorEngine {
    const client = actor(ConnectorAccounts, connectorAccountsKey(input.workspaceId)).with({ context: asPrincipal(input.principal) }) as unknown as ConnectorAccountsClient;
    return createConnectorEngine({
        secret: input.engineSecret,
        ...connectorAccountStores(client),
        clients: clientFromSecrets((name) => input.secret(name), input.pluginId),
        redirectUri: input.redirectUri,
        ...(input.http ? { http: input.http } : {}),
        ...(input.allowedHosts ? { allowedHosts: input.allowedHosts } : {})
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
    get(id: string): Promise<{ readonly enabled: boolean; readonly grantedPermissions?: readonly PermissionScope[] } | null>;
    getConnector(id: string): Promise<{ readonly id: string; readonly pluginId: string; readonly transport: string; readonly connector?: string; readonly account?: string } | null>;
    putConnector(input: { readonly id: string; readonly pluginId: string; readonly transport: 'conduit'; readonly connector: string; readonly account?: string }): Promise<unknown>;
    openSecret(name: string, pluginId: string): Promise<string>;
    setSecret(name: string, value: string): Promise<unknown>;
    /** Names and timestamps only (`SecretInfo`) — whether a secret is set, readable without opening it. */
    secrets(): Promise<readonly { readonly name: string; readonly updatedAt: number }[]>;
}

/**
 * A connector plugin's secret, `undefined` when it is not set. Any other refusal (plugin off, not granted) throws.
 *
 * "Not set" is read from `secrets()` (names only), not from the refusal: these routes call the Registry from the
 * Worker, where a production build masks every refusal that is not a `ServerFnError` to a bare "Internal error" —
 * no `code`, no message (#557). The refusal check stays for the window between the two reads.
 */
export async function openPluginSecret(registry: Pick<ConnectorRegistry, 'openSecret' | 'secrets'>, name: string, pluginId: string): Promise<string | undefined> {
    if (!(await registry.secrets()).some((s) => s.name === name)) return undefined;
    try {
        return await registry.openSecret(name, pluginId);
    } catch (e) {
        if (isSecretMissing(e)) return undefined;
        throw e;
    }
}

/**
 * The workspace's engine secret, generated and sealed in the Registry the first time (the owner's call).
 *
 * Generation only happens while the secret is MISSING, so no account is sealed under an earlier value (short of the
 * owner removing it by hand, which strands those accounts already) and an overwrite never strands a connected
 * account. Two first Connects racing in one workspace both write; the value is
 * read back after the write, so each flow signs with what the Registry holds, and at worst the loser's sign-in link
 * says "start again". A write-once Registry API would close that window entirely; it is not worth a platform seam
 * for a race only the owner can start against themselves.
 */
export async function ensureEngineSecret(registry: Pick<ConnectorRegistry, 'openSecret' | 'setSecret' | 'secrets'>, pluginId: string): Promise<string> {
    const existing = await openPluginSecret(registry, CONNECTOR_ENGINE_SECRET, pluginId);
    if (existing !== undefined) return existing;
    const secret = newEngineSecret();
    await registry.setSecret(CONNECTOR_ENGINE_SECRET, secret);
    return (await openPluginSecret(registry, CONNECTOR_ENGINE_SECRET, pluginId)) ?? secret;
}
