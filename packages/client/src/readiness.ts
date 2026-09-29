/**
 * The pure plugin-readiness rules (#233, PLG-03; #635, OPS-04), moved here from
 * `apps/web/src/pages/plugins/readiness.ts` (#1121) so the planned Lynx shell
 * reuses them: core's `pluginReadiness` over the Registry's `overview()` and
 * the workspace's environments, plus the plugin ids whose sign-in lapsed,
 * read from the Registry's connector records and the `ConnectorAccounts`
 * summaries. No reads here; the registry store (`stores/registry.ts`) holds those.
 */
import { pluginReadiness, type PluginReadiness, type PluginReadinessFacts, type PluginState, type RuntimeId } from '@agentic/core';
import type { ConnectorAccountSummary, ConnectorRecord, RegistryOverview } from '@agentic/platform';

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
 * record whose account is gone is not counted: disconnect revokes the
 * account before it clears the record, and the two live pushes can land out
 * of order — the plugin page's own Reconnect pill covers that case. Accounts
 * still loading (`undefined`) sign nothing out.
 */
export function signedOutPluginIds(
    records: readonly Pick<ConnectorRecord, 'pluginId' | 'transport' | 'account' | 'status'>[],
    accounts: readonly ConnectorAccountSummary[] | undefined
): string[] {
    const out = new Set<string>();
    for (const r of records) {
        if (r.transport === 'conduit') {
            if (r.account !== undefined && accounts?.find((a) => a.id === r.account)?.status === 'needsReauth') out.add(r.pluginId);
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
