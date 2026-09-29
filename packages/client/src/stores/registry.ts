/**
 * The registry store (#1121): the one owner of the workspace Registry's and
 * `ConnectorAccounts`' live reads — `Registry.overview`, `connectors`,
 * `projectFeatures` and `secrets`, and `ConnectorAccounts.accounts`, for the
 * viewer's workspace. Readiness (`useWorkspaceReadiness`), the feature `ui`
 * lookup (`useFeatureUi`) and every page naming a plugin, a connector or a
 * secret read them here, so a route change reuses the app's subscriptions
 * instead of redialling the Registry.
 *
 * With no actor definitions or viewer provided (a render on mock data), the
 * store reads nothing and every selector answers empty.
 */
import { computed } from '@sigx/reactivity';
import type { ConnectorAccountSummary, ConnectorRecord, ProjectFeatureView, RegistryOverview, SecretInfo } from '@agentic/platform';
import { useActorDefs } from '../defs';
import { signedOutPluginIds } from '../readiness';
import { useViewer } from '../viewer';
import { defineAppStore } from './define';
import { useLiveActorState, type LiveActorState } from './live';

/** The Registry's key — the platform's `registryKey`, spelled here so the bundle never imports the platform for a string. */
const registryKeyOf = (ws: string): string => `${ws}:registry`;
/** The workspace's `ConnectorAccounts` key — the platform's `connectorAccountsKey`. */
const connectorAccountsKeyOf = (ws: string): string => `${ws}:connector-accounts`;

/** The read a store without actor definitions holds: never loading, never a value. */
const idle = <T>(): LiveActorState<T> => ({ state: 'idle', value: undefined, hasValue: false, loading: false, error: null, refresh: async () => undefined });

/** An injectable the app may not provide (a render on mock data): `null` then. */
function optional<T>(use: () => T): T | null {
    try {
        return use();
    } catch {
        return null;
    }
}

export const useRegistryStore = defineAppStore('registry', (ctx) => {
    const defs = optional(useActorDefs);
    const viewer = defs ? optional(() => useViewer()()) : null;
    const registry = (): string | null => (viewer?.workspaceId ? registryKeyOf(viewer.workspaceId) : null);
    const accountsKey = (): string | null => (viewer?.workspaceId ? connectorAccountsKeyOf(viewer.workspaceId) : null);
    // A def the app does not provide (a test or a shell with a partial set) reads nothing, like no defs at all.
    const Registry = viewer ? defs?.Registry : undefined;
    const Accounts = viewer ? defs?.ConnectorAccounts : undefined;
    const overviewRead = Registry ? useLiveActorState(ctx, Registry, () => { const k = registry(); return k ? ([k, 'overview'] as const) : null; }) : idle<RegistryOverview>();
    const connectorsRead = Registry ? useLiveActorState(ctx, Registry, () => { const k = registry(); return k ? ([k, 'connectors'] as const) : null; }) : idle<ConnectorRecord[]>();
    const projectFeaturesRead = Registry ? useLiveActorState(ctx, Registry, () => { const k = registry(); return k ? ([k, 'projectFeatures'] as const) : null; }) : idle<ProjectFeatureView[]>();
    const secretsRead = Registry ? useLiveActorState(ctx, Registry, () => { const k = registry(); return k ? ([k, 'secrets'] as const) : null; }) : idle<SecretInfo[]>();
    const accountsRead = Accounts ? useLiveActorState(ctx, Accounts, () => { const k = accountsKey(); return k ? ([k, 'accounts'] as const) : null; }) : idle<ConnectorAccountSummary[]>();

    /** `Registry.overview()`: the plugins, the secret names, whether the deployment can seal; `undefined` until it lands. */
    const overview = computed(() => overviewRead.value);
    /** `Registry.connectors()`; `undefined` until it lands. */
    const connectors = computed(() => connectorsRead.value);
    /** `Registry.projectFeatures()`; empty until it lands. */
    const projectFeatures = computed(() => projectFeaturesRead.value ?? []);
    /** `Registry.secrets()` (names and metadata, never values); `undefined` until it lands. */
    const secrets = computed(() => secretsRead.value);
    /** `ConnectorAccounts.accounts()` (summaries, never credentials); `undefined` until it lands. */
    const accounts = computed(() => accountsRead.value);
    /** The plugin ids whose sign-in lapsed; nothing is signed out until the records land, or while the accounts load. */
    const signedOut = computed(() => signedOutPluginIds(connectorsRead.value ?? [], accountsRead.value ?? undefined));

    return {
        overview,
        connectors,
        projectFeatures,
        secrets,
        accounts,
        signedOut,
        /** The reads themselves, for a page that needs a read's state (`loading`, `refresh`) as well as its value. */
        overviewRead,
        connectorsRead,
        projectFeaturesRead,
        secretsRead,
        accountsRead
    };
});
