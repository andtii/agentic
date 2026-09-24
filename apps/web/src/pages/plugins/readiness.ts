/**
 * Whether a plugin can be used right now (#233, PLG-03): core's pure
 * `pluginReadiness` over the two reads a page already has — the Registry's
 * `overview()` (which secrets are set, whether the deployment can seal any)
 * and the workspace's live environments (whether a daemon-hosted runtime has
 * a machine). Exported for every page that names a plugin's state: the
 * catalogue, the plugin page, the agent form's runtime hints and the Home
 * checklist (#234). A connector whose account needs signing in again
 * (#635, OPS-04) reads `needs-sign-in` from the Registry's connector records
 * and the workspace's `ConnectorAccounts` summaries, live.
 */
import { pluginReadiness, type PluginReadiness, type PluginReadinessFacts, type PluginState, type RuntimeId } from '@agentic/core';
import { useActorState } from '@sigx/actors/app';
import type { ConnectorAccountSummary, ConnectorRecord, RegistryOverview } from '@agentic/platform';
import type { ActorDefs, ViewerState } from '../../actors/defs';
import { connectorAccountsKeyOf, registryKeyOf } from '../../actors/keys';
import { useEnvironmentDirectory } from '../ops/environments';
import { connectionOf } from './conduit';

/**
 * What `pluginReadiness` needs, from an `overview()` and the environments the
 * paired machines report, plus the plugin ids whose sign-in lapsed
 * (`signedOutPluginIds`); a mock passes its own `signedOut`.
 */
export function readinessFacts(
    overview: Pick<RegistryOverview, 'secretNames' | 'hasKek'> & { readonly signedOut?: readonly string[] },
    environments: readonly { readonly runtime: RuntimeId }[],
    signedOut: readonly string[] | undefined = overview.signedOut
): PluginReadinessFacts {
    return { secretNames: overview.secretNames, environments: environments.map((e) => ({ runtime: e.runtime })), hasKek: overview.hasKek, ...(signedOut?.length ? { signedOut } : {}) };
}

/**
 * An MCP connector's last error that means its credential was refused: an
 * HTTP 401 or 403 (`… failed with HTTP 401`) or an OAuth / auth error word.
 * Deliberately narrow — a timeout, a 404 or a 500 is not a sign-in problem.
 */
export function isAuthError(message: string | undefined): boolean {
    if (!message) return false;
    return /\b(?:HTTP|status)\s*40[13]\b/i.test(message) || /\b(?:unauthori[sz]ed|forbidden|invalid_token|invalid_grant|needs reauth)\b/i.test(message);
}

/**
 * The plugin ids whose sign-in lapsed: a conduit record whose account needs
 * reauth, or an MCP record whose last check failed with an auth error. A
 * record whose account is gone (`missing`) is not counted: disconnect revokes
 * the account before it clears the record, and the two live pushes can land
 * out of order — the plugin page's own Reconnect pill covers that case.
 * Accounts still loading (`undefined`) sign nothing out.
 */
export function signedOutPluginIds(
    records: readonly Pick<ConnectorRecord, 'pluginId' | 'transport' | 'account' | 'status'>[],
    accounts: readonly ConnectorAccountSummary[] | undefined
): string[] {
    const out = new Set<string>();
    for (const r of records) {
        if (r.transport === 'conduit') {
            const c = connectionOf(r, accounts);
            if (c?.state === 'needs-reauth') out.add(r.pluginId);
        } else if (r.status.state === 'error' && isAuthError(r.status.error)) {
            out.add(r.pluginId);
        }
    }
    return [...out];
}

/** Every plugin's readiness, by id. */
export function readinessById(plugins: readonly PluginState[], facts: PluginReadinessFacts): Record<string, PluginReadiness> {
    return Object.fromEntries(plugins.map((p) => [p.manifest.id, pluginReadiness(p, facts)]));
}

/** The `runtime` plugins an agent could run on right now. */
export function readyRuntimeIds(plugins: readonly PluginState[], facts: PluginReadinessFacts): string[] {
    return plugins.filter((p) => p.manifest.kind === 'runtime' && pluginReadiness(p, facts).status === 'ready').map((p) => p.manifest.id);
}

export interface WorkspaceReadiness {
    /** The Registry's `overview()`, live; `undefined` until it lands. */
    overview(): RegistryOverview | undefined;
    /** `null` until BOTH reads have landed — a runtime must not flash "needs a machine" while the machines load. */
    facts(): PluginReadinessFacts | null;
    /** One plugin's readiness; `undefined` while `facts()` is `null`. */
    of(plugin: PluginState): PluginReadiness | undefined;
    byId(): Record<string, PluginReadiness>;
    readyRuntimes(): string[];
    readonly loading: boolean;
}

/**
 * The workspace's plugins and what each still needs: one live `overview()`
 * read plus the environment directory, and the connector records and account
 * summaries (the reads `LiveConduitConnect` makes) for who needs signing in.
 */
export function useWorkspaceReadiness(defs: Pick<ActorDefs, 'Registry' | 'Workspace' | 'Machine' | 'ConnectorAccounts'>, viewer: Pick<ViewerState, 'workspaceId'>): WorkspaceReadiness {
    const overview = useActorState(defs.Registry, () => { const ws = viewer.workspaceId; return ws && ([registryKeyOf(ws), 'overview'] as const); }, { live: true });
    const connectors = useActorState(defs.Registry, () => { const ws = viewer.workspaceId; return ws && ([registryKeyOf(ws), 'connectors'] as const); }, { live: true });
    const accounts = useActorState(defs.ConnectorAccounts, () => { const ws = viewer.workspaceId; return ws && ([connectorAccountsKeyOf(ws), 'accounts'] as const); }, { live: true });
    const environments = useEnvironmentDirectory(defs, viewer);
    // The sign-in reads never hold `facts()` back: until they land nothing is signed out.
    const signedOut = (): string[] => signedOutPluginIds(connectors.value ?? [], accounts.value ?? undefined);
    const facts = (): PluginReadinessFacts | null => (overview.value && !environments.loading ? readinessFacts(overview.value, environments.all().map((e) => e.descriptor), signedOut()) : null);
    return {
        overview: () => overview.value ?? undefined,
        facts,
        of: (plugin) => { const f = facts(); return f ? pluginReadiness(plugin, f) : undefined; },
        byId: () => { const f = facts(); return f && overview.value ? readinessById(overview.value.plugins, f) : {}; },
        readyRuntimes: () => { const f = facts(); return f && overview.value ? readyRuntimeIds(overview.value.plugins, f) : []; },
        get loading() {
            return overview.loading || environments.loading;
        }
    };
}
