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
 *   `claude-code` on a machine's daemon.
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
 * another one active (#243 moves the memories with it).
 */
import type { AnthropicApiRuntimeOptions, CatalogueEntry, ChannelCatalogue, LearningPluginImpl, MemoryPluginImpl, RuntimeCatalogue } from '@agentic/platform';
import { WEB_PUSH_PLUGIN_ID, anthropicApiRuntime, flatMemoryActorImpl, memoryActorImpl, webPushChannelPlugin, webPushPlugin } from '@agentic/platform';
import { learningDefaultPlugin, learningPlugin } from '@agentic/learning';
import { openMcpConnector } from '@agentic/mcp';
import { memoryDefaultPlugin, memoryFlatPlugin } from '@agentic/memory';
import { ANTHROPIC_API_PLUGIN_ID, CLAUDE_CODE_PLUGIN_ID, anthropicApiPlugin, claudeCodePlugin, claudeCodeQuotaPlugin } from '@agentic/runtimes';

/** The manifests the Registry lists for every workspace — enabled (Web Push excepted), with their declared scopes granted, until the owner changes them. */
export const pluginCatalogue: readonly CatalogueEntry[] = [
    anthropicApiPlugin,
    claudeCodePlugin,
    memoryDefaultPlugin,
    memoryFlatPlugin,
    learningDefaultPlugin,
    // Off until the owner sets a contact and generates keys on its page (#244).
    { manifest: webPushPlugin, enabledByDefault: false },
    // What the daemon reads each Claude Code account's plan limits with (#261); the daemon runs it, the Registry lists it.
    claudeCodeQuotaPlugin
];

/** Runtime id → where its sessions run. The ids are the runtime plugins' ids. */
export function runtimeCatalogue(options: AnthropicApiRuntimeOptions): RuntimeCatalogue {
    return {
        [ANTHROPIC_API_PLUGIN_ID]: anthropicApiRuntime({ connectors: openMcpConnector, ...options }),
        [CLAUDE_CODE_PLUGIN_ID]: { host: 'daemon' }
    };
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
