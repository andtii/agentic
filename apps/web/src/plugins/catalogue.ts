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
 * The flat memory plugin ships turned off: this build holds its entries in the
 * isolate's memory (lost when the isolate goes) and serves an agent's own
 * scope only — a plugin for trying the migration path (#243), not for keeping
 * memories.
 */
import type { AnthropicApiRuntimeOptions, CatalogueEntry, ChannelCatalogue, LearningPluginImpl, MemoryPluginImpl, RuntimeCatalogue } from '@agentic/platform';
import { WEB_PUSH_PLUGIN_ID, anthropicApiRuntime, isolateMemoryImpl, memoryActorImpl, webPushChannelPlugin, webPushPlugin } from '@agentic/platform';
import { learningDefaultPlugin, learningPlugin } from '@agentic/learning';
import { flatMemoryPlugin, memoryDefaultPlugin, memoryFlatPlugin } from '@agentic/memory';
import { ANTHROPIC_API_PLUGIN_ID, CLAUDE_CODE_PLUGIN_ID, anthropicApiPlugin, claudeCodePlugin } from '@agentic/runtimes';

/** The manifests the Registry lists for every workspace — enabled (the flat memory plugin and Web Push excepted), with their declared scopes granted, until the owner changes them. */
export const pluginCatalogue: readonly CatalogueEntry[] = [
    anthropicApiPlugin,
    claudeCodePlugin,
    memoryDefaultPlugin,
    { manifest: memoryFlatPlugin, enabledByDefault: false },
    learningDefaultPlugin,
    // Off until the owner sets a contact and generates keys on its page (#244).
    { manifest: webPushPlugin, enabledByDefault: false }
];

/** Runtime id → where its sessions run. The ids are the runtime plugins' ids. */
export function runtimeCatalogue(options: AnthropicApiRuntimeOptions): RuntimeCatalogue {
    return {
        [ANTHROPIC_API_PLUGIN_ID]: anthropicApiRuntime(options),
        [CLAUDE_CODE_PLUGIN_ID]: { host: 'daemon' }
    };
}

/** Memory plugin id → the store a session opens: the Memory actor for the default, the isolate's map for the flat one. */
export const memoryCatalogue: Readonly<Record<string, MemoryPluginImpl>> = {
    [memoryDefaultPlugin.id]: memoryActorImpl(),
    [memoryFlatPlugin.id]: isolateMemoryImpl(() => flatMemoryPlugin())
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
