/**
 * Whether a plugin can be used right now (#233, PLG-03): core's pure
 * `pluginReadiness` over the two reads a page already has — the Registry's
 * `overview()` (which secrets are set, whether the deployment can seal any)
 * and the workspace's live environments (whether a daemon-hosted runtime has
 * a machine). Exported for every page that names a plugin's state: the
 * catalogue, the plugin page, the agent form's runtime hints and the Home
 * checklist (#234).
 */
import { pluginReadiness, type PluginReadiness, type PluginReadinessFacts, type PluginState, type RuntimeId } from '@agentic/core';
import { useActorState } from '@sigx/actors/app';
import type { RegistryOverview } from '@agentic/platform';
import type { ActorDefs, ViewerState } from '../../actors/defs';
import { registryKeyOf } from '../../actors/keys';
import { useEnvironmentDirectory } from '../ops/environments';

/** What `pluginReadiness` needs, from an `overview()` and the environments the paired machines report. */
export function readinessFacts(overview: Pick<RegistryOverview, 'secretNames' | 'hasKek'>, environments: readonly { readonly runtime: RuntimeId }[]): PluginReadinessFacts {
    return { secretNames: overview.secretNames, environments: environments.map((e) => ({ runtime: e.runtime })), hasKek: overview.hasKek };
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

/** The workspace's plugins and what each still needs: one live `overview()` read plus the environment directory. */
export function useWorkspaceReadiness(defs: Pick<ActorDefs, 'Registry' | 'Workspace' | 'Machine'>, viewer: Pick<ViewerState, 'workspaceId'>): WorkspaceReadiness {
    const overview = useActorState(defs.Registry, () => { const ws = viewer.workspaceId; return ws && ([registryKeyOf(ws), 'overview'] as const); }, { live: true });
    const environments = useEnvironmentDirectory(defs, viewer);
    const facts = (): PluginReadinessFacts | null => (overview.value && !environments.loading ? readinessFacts(overview.value, environments.all().map((e) => e.descriptor)) : null);
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
