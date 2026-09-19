/**
 * The build's plugins (#231, architecture §9): every capability this
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
 *
 * Memory and learning are still wired statically (`platformLearningPorts`);
 * #242 resolves them through the active plugin.
 *
 * The A2A server (#245) is off until the owner turns it on: its implementation
 * is the Worker's `/a2a` mount (`src/a2a/mount.ts`), which asks the Registry on
 * every request.
 */
import { a2aServerPlugin } from '@agentic/a2a';
import type { AnthropicApiRuntimeOptions, CatalogueEntry, RuntimeCatalogue } from '@agentic/platform';
import { anthropicApiRuntime } from '@agentic/platform';
import { learningDefaultPlugin } from '@agentic/learning';
import { memoryDefaultPlugin, memoryFlatPlugin } from '@agentic/memory';
import { ANTHROPIC_API_PLUGIN_ID, CLAUDE_CODE_PLUGIN_ID, anthropicApiPlugin, claudeCodePlugin } from '@agentic/runtimes';

/** The manifests the Registry lists for every workspace — enabled, with their declared scopes granted, until the owner changes them. */
export const pluginCatalogue: readonly CatalogueEntry[] = [anthropicApiPlugin, claudeCodePlugin, memoryDefaultPlugin, memoryFlatPlugin, learningDefaultPlugin, { manifest: a2aServerPlugin, enabledByDefault: false }];

/** Runtime id → where its sessions run. The ids are the runtime plugins' ids. */
export function runtimeCatalogue(options: AnthropicApiRuntimeOptions): RuntimeCatalogue {
    return {
        [ANTHROPIC_API_PLUGIN_ID]: anthropicApiRuntime(options),
        [CLAUDE_CODE_PLUGIN_ID]: { host: 'daemon' }
    };
}
