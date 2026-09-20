/**
 * The build's plugins (#231, #242, architecture §9): every capability this
 * deployment ships, as a manifest the Registry lists and an implementation
 * the actors run. Composed here, at the app's root, because the manifests live
 * beside their code in packages that `@agentic/platform` may not import
 * (`@agentic/learning`) and the implementations need the app's own actor
 * definitions.
 *
 * - `pluginCatalogue` → `defineRegistry({ catalogue })`. ORDER matters: the
 *   first plugin of a single-slot kind (memory, learning) is that slot's
 *   default, so the default memory plugin comes before the flat one.
 * - `runtimeCatalogue(options)` → both `createSessionFactory({ runtimes })`
 *   and `defineRoutingActor({ runtimes })`: `anthropic-api` runs in-process
 *   with its key from the workspace's `anthropic-api-key` Registry secret,
 *   and opens the agent's MCP connectors with `openMcpConnector` (#240);
 *   the harness runtimes (`claude-code`, `copilot-cli`, `codex-cli`, #322) on a machine's daemon.
 * - `memoryCatalogue` / `learningCatalogue` → `platformLearningPorts({
 *   memoryPlugins, learningPlugins })`: the workspace's ACTIVE memory and
 *   learning plugin, over its config, is what each session remembers in and
 *   learns through (#242); turned off, a session retrieves, writes and learns
 *   nothing.
 * - `channelCatalogue` → `defineInbox({ channelPlugins })`: the notification
 *   plugins this build implements, opened per notification while the
 *   workspace has them on (#244). Web Push ships off: it needs keys first.
 *
 * Both memory plugins are durable: the default one is the Memory actor of each
 * scope, the flat one the FlatMemory actor of each scope (#281), and a shared
 * scope's ACL (the Memory actor's) governs both. The flat plugin is enabled but
 * not active — the default stays the workspace's memory until the owner makes
 * another one active, and making it active moves the memories with it
 * (#243: the Registry moves them between the `memoryCatalogue` implementations).
 *
 * The A2A server (#245) ships off until the owner turns it on: its
 * implementation is the Worker's A2A mount (`src/a2a/mount.ts`), which asks
 * the Registry on every request.
 */
import { A2A_PEER_PREFIX, a2aPeerRuntime, a2aServerPlugin } from '@agentic/a2a';
import type { ProjectFeaturePlugin } from '@agentic/core';
import type { AnthropicApiRuntimeOptions, CatalogueEntry, ChannelCatalogue, LearningPluginImpl, MemoryPluginImpl, RuntimeCatalogue } from '@agentic/platform';
import { WEB_PUSH_PLUGIN_ID, anthropicApiRuntime, flatMemoryActorImpl, withInstanceRuntimes, memoryActorImpl, webPushChannelPlugin, webPushPlugin } from '@agentic/platform';
import { learningDefaultPlugin, learningPlugin } from '@agentic/learning';
import { openMcpConnector } from '@agentic/mcp';
import { memoryDefaultPlugin, memoryFlatPlugin } from '@agentic/memory';
import { GIT_FEATURE_ID, gitFeatureManifest, gitFeaturePlugin } from '@agentic/plugins-git';
import { ANTHROPIC_API_PLUGIN_ID, CLAUDE_CODE_PLUGIN_ID, CODEX_CLI_PLUGIN_ID, COPILOT_CLI_PLUGIN_ID, anthropicApiPlugin, claudeCodePlugin, codexCliPlugin, copilotCliPlugin } from '@agentic/runtimes';

/** The manifests the Registry lists for every workspace — enabled (Web Push and the A2A server excepted), with their declared scopes granted, until the owner changes them. */
export const pluginCatalogue: readonly CatalogueEntry[] = [
    anthropicApiPlugin,
    claudeCodePlugin,
    copilotCliPlugin,
    codexCliPlugin,
    memoryDefaultPlugin,
    memoryFlatPlugin,
    learningDefaultPlugin,
    // On, but it only acts on a project that switches it on (#335).
    gitFeatureManifest,
    // Off until the owner sets a contact and generates keys on its page (#244).
    { manifest: webPushPlugin, enabledByDefault: false },
    { manifest: a2aServerPlugin, enabledByDefault: false }
];

/**
 * Runtime id → where its sessions run. The ids are the runtime plugins' ids: the build's own, and the A2A peers a
 * workspace adds (`a2a.<id>`, #246), each a local runtime over `a2aAgent` reading its card URL and token from its plugin.
 */
export function runtimeCatalogue(options: AnthropicApiRuntimeOptions): RuntimeCatalogue {
    return withInstanceRuntimes(
        {
            [ANTHROPIC_API_PLUGIN_ID]: anthropicApiRuntime({ connectors: openMcpConnector, ...options }),
            [CLAUDE_CODE_PLUGIN_ID]: { host: 'daemon' },
            [COPILOT_CLI_PLUGIN_ID]: { host: 'daemon' },
            [CODEX_CLI_PLUGIN_ID]: { host: 'daemon' }
        },
        { [A2A_PEER_PREFIX]: (runtime) => a2aPeerRuntime(runtime) }
    );
}

/** Memory plugin id → the store a session opens: the Memory actor for the default, the FlatMemory actor for the flat one. */
export const memoryCatalogue: Readonly<Record<string, MemoryPluginImpl>> = {
    [memoryDefaultPlugin.id]: memoryActorImpl(),
    [memoryFlatPlugin.id]: flatMemoryActorImpl()
};

function positiveInteger(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined;
}

/** Learning plugin id → a plugin per session, over the session's objective and tags (a lesson's conditions). */
export const learningCatalogue: Readonly<Record<string, LearningPluginImpl>> = {
    [learningDefaultPlugin.id]: (config) => {
        const repeatThreshold = positiveInteger(config['repeatThreshold']);
        return (c) =>
            learningPlugin({
                ...(repeatThreshold ? { repeatThreshold } : {}),
                contextFor: () => ({ ...(c.objective ? { objective: c.objective } : {}), ...(c.tags ? { tags: c.tags } : {}) })
            });
    }
};

/** Notification plugin id → its channel. The ids are the notification plugins' ids. */
export const channelCatalogue: ChannelCatalogue = {
    [WEB_PUSH_PLUGIN_ID]: webPushChannelPlugin()
};

/**
 * Project feature plugin id → its code half (#329): `detect` suggests the feature when a project folder is added,
 * `beforeSession` / `instructions` run on the router (`defineRoutingActor({ projectFeatures })`). The git feature
 * (#335, `@agentic/plugins-git`): a worktree per chat through the daemon's `worktree` op, and repo instructions.
 */
export const projectFeatureCatalogue: Readonly<Record<string, ProjectFeaturePlugin>> = { [GIT_FEATURE_ID]: gitFeaturePlugin };
