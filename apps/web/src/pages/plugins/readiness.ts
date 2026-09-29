/**
 * Whether a plugin can be used right now (#233, PLG-03): core's pure
 * `pluginReadiness` over the Registry's `overview()` (which secrets are set,
 * whether the deployment can seal any) and the workspace's live environments
 * (whether a daemon-hosted runtime has a machine). Exported for every page
 * that names a plugin's state: the catalogue, the plugin page, the agent
 * form's runtime hints and the Home checklist (#234). A connector whose
 * account needs signing in again (#635, OPS-04) reads `needs-sign-in` from the
 * Registry's connector records and the workspace's `ConnectorAccounts`
 * summaries. The pure rules and the live reads live in `@agentic/client`
 * (#1121): the rules next to the registry store, which owns the reads.
 */
import { pluginReadiness, type PluginReadiness, type PluginReadinessFacts, type PluginState } from '@agentic/core';
import type { RegistryOverview } from '@agentic/platform';
import { readinessById, readinessFacts, readyRuntimeIds, useRegistryStore } from '@agentic/client';
import type { ActorDefs, ViewerState } from '../../actors/defs';
import { useEnvironmentDirectory } from '../ops/environments';

export { isAuthError, readinessById, readinessFacts, readyRuntimeIds, signedOutPluginIds } from '@agentic/client';

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
 * The workspace's plugins and what each still needs: the registry store's
 * `overview()`, connector records and account summaries (who needs signing
 * in), plus the environment directory. A selector: it opens no read of its own.
 */
export function useWorkspaceReadiness(defs: Pick<ActorDefs, 'Registry' | 'Workspace' | 'Machine' | 'ConnectorAccounts'>, viewer: Pick<ViewerState, 'workspaceId'>): WorkspaceReadiness {
    const store = useRegistryStore();
    const overview = store.overviewRead;
    const environments = useEnvironmentDirectory(defs, viewer);
    // The sign-in reads never hold `facts()` back: until they land nothing is signed out.
    const signedOut = (): string[] => store.signedOut;
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
