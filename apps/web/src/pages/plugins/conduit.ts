/**
 * A conduit connector's page model (#533; AGT-09, AST-09, PLG-02, PLG-04):
 * pure, over what the plugin page already reads — the plugin's view, the
 * workspace's secret names, its connector record and the connected
 * accounts' summaries (never a credential). No hook, no DOM.
 */
import type { PluginManifest } from '@agentic/core';
import type { ConnectorAccountSummary, ConnectorRecord, PluginView } from '@agentic/platform';
import { CONNECT_ERROR_PARAM, CONNECTED_PARAM, CONNECTOR_ENGINE_SECRET_NAME } from '../../connectors/paths';

/** A connector plugin that signs in through conduit: it declares the workspace's engine secret. */
export function isConduitConnector(manifest: PluginManifest): boolean {
    return manifest.kind === 'connector' && !!manifest.secrets?.some((s) => s.name === CONNECTOR_ENGINE_SECRET_NAME);
}

/** Secrets the plugin manages itself and the page never offers a field for. */
export function managedSecretsOf(manifest: PluginManifest): readonly string[] {
    return isConduitConnector(manifest) ? [CONNECTOR_ENGINE_SECRET_NAME] : [];
}

/** The secrets the owner sets: every declared one but the engine secret (the OAuth client id and secret). */
export function ownerSecretsOf(manifest: PluginManifest): readonly string[] {
    const managed = managedSecretsOf(manifest);
    return (manifest.secrets ?? []).map((s) => s.name).filter((n) => !managed.includes(n));
}

export type ConnectionState =
    /** No account on the record (never connected, or disconnected). */
    | { readonly state: 'not-connected' }
    /** Connected and usable. */
    | { readonly state: 'active'; readonly account: ConnectorAccountSummary }
    /** Its refresh was refused (expired or revoked sign-in): Reconnect. */
    | { readonly state: 'needs-reauth'; readonly account: ConnectorAccountSummary }
    /** The record names an account the workspace no longer holds: Reconnect. */
    | { readonly state: 'missing'; readonly accountId: string };

/** The connector's account, as the page shows it. `accounts` still loading reads as not connected only when the record names none. */
export function connectionOf(record: Pick<ConnectorRecord, 'transport' | 'account'> | undefined, accounts: readonly ConnectorAccountSummary[] | undefined): ConnectionState | undefined {
    if (!record || record.transport !== 'conduit' || record.account === undefined) return { state: 'not-connected' };
    if (!accounts) return undefined;
    const account = accounts.find((a) => a.id === record.account);
    if (!account) return { state: 'missing', accountId: record.account };
    return account.status === 'needsReauth' ? { state: 'needs-reauth', account } : { state: 'active', account };
}

/** The status pill: kit statuses, the page's own words. */
export function connectionPill(c: ConnectionState): { readonly status: 'auth-ok' | 'auth-expired' | 'auth-missing'; readonly label: string } {
    switch (c.state) {
        case 'active':
            return { status: 'auth-ok', label: 'CONNECTED' };
        case 'needs-reauth':
        case 'missing':
            return { status: 'auth-expired', label: 'NEEDS RECONNECTING' };
        default:
            return { status: 'auth-missing', label: 'NOT CONNECTED' };
    }
}

/** One line under the pill: who is connected, or what to do. */
export function connectionText(c: ConnectionState, name: string): string {
    switch (c.state) {
        case 'active':
            return `Connected as ${c.account.displayName ?? c.account.id}. Agents you give ${name} to act as this account.`;
        case 'needs-reauth':
            return `The sign-in for ${c.account.displayName ?? c.account.id} expired or was revoked. Reconnect to keep agents using it — their calls fail until then.`;
        case 'missing':
            return `The connected account is gone from this workspace. Reconnect to sign in again.`;
        default:
            return `Not connected. Connect signs in to ${name} with the OAuth client above.`;
    }
}

/** Why Connect cannot run yet, or `undefined` when it can. */
export function connectBlocker(plugin: Pick<PluginView, 'enabled' | 'manifest'>, secretNames: readonly string[], hasKek: boolean): string | undefined {
    if (!hasKek) return 'This deployment has no WORKSPACE_KEK, so it cannot seal the OAuth client or the account.';
    if (!plugin.enabled) return `Turn ${plugin.manifest.name} on first (the switch above).`;
    const missing = ownerSecretsOf(plugin.manifest).filter((n) => {
        const declared = plugin.manifest.secrets?.find((s) => s.name === n);
        return declared?.required && !secretNames.includes(n);
    });
    if (missing.length) return `Save the ${missing.map((n) => plugin.manifest.secrets?.find((s) => s.name === n)?.title ?? n).join(' and ')} above first.`;
    return undefined;
}

export interface OperationRow {
    readonly id: string;
    /** `search-messages` → `Search messages`. */
    readonly label: string;
}

const labelOf = (id: string): string => {
    const words = id.replace(/[-_]+/g, ' ').trim();
    return words ? words[0]!.toUpperCase() + words.slice(1) : id;
};

/** What agents can call (AGT-09): the manifest's `operation:<id>` capabilities, in its order. */
export function operationsOf(manifest: PluginManifest): OperationRow[] {
    return manifest.capabilities.filter((c) => c.startsWith('operation:')).map((c) => c.slice('operation:'.length)).map((id) => ({ id, label: labelOf(id) }));
}

/** What the connector has that this deployment does not run yet (`unsupported:trigger:new-email` → `New email (trigger)`). */
export function unsupportedOf(manifest: PluginManifest): string[] {
    return manifest.capabilities
        .filter((c) => c.startsWith('unsupported:'))
        .map((c) => c.slice('unsupported:'.length).split(':'))
        .map(([kind, id]) => (id ? `${labelOf(id)} (${kind})` : labelOf(kind ?? '')));
}

/** What the sign-in routes said when they sent the owner back (`?connected=1`, `?connect_error=…`). */
export function connectOutcome(query: Readonly<Record<string, unknown>>): { readonly connected: boolean; readonly error?: string } {
    const first = (v: unknown): string | undefined => (Array.isArray(v) ? first(v[0]) : typeof v === 'string' ? v : undefined);
    const error = first(query[CONNECT_ERROR_PARAM]);
    return error ? { connected: false, error: error.slice(0, 300) } : { connected: first(query[CONNECTED_PARAM]) === '1' };
}
