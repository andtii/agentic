/**
 * The concrete `SessionFactory` (architecture §5a): a runtime id is looked up
 * in the app's `RuntimeCatalogue`. A `local` runtime opens in-process — the
 * built-in one is `anthropicApiRuntime()`, `createPlatformModelAgent` over the
 * actor tool ports; a `daemon` runtime answers `null` (the Session then
 * expects frames from a Machine); an id the catalogue does not know fails the
 * open `unknown-runtime`. Keys are BYO (§5a): with a `registry`, the runtime's
 * secrets come from `Registry.openSecret(name, pluginId)` as the workspace's
 * owner — enabled and granted, audited, once per open — and are never kept in
 * the isolate; a missing key fails the open with a clear error, never a
 * silent fallback to the deployment's environment.
 * Sessions open under the policy compiled from the agent's config
 * (`sessionPolicy`: approval rules, tool grants, then allow), constrained by
 * the ancestors' rules on a delegated task (AC-12) — `policy` overrides it.
 * An `ask` decision raises a `request` the user answers from any client
 * through `Session.respond` (OPS-02); on the daemon path the same rules
 * travel as `OpenSpec.policy` and the daemon compiles them (#121). With a
 * Session definition, `ask_user` raises its input request there (#122).
 * The memories the Session retrieved at `open` (`spec.memories`, ranked on
 * the task's objective) go in as `memories`: `buildSystemPrompt` renders them
 * as the prompt's memory block — the one rendering on the local path (§8, #135).
 */

import type { ChatFileStore, RuntimeId } from '@agentic/core';
import { ANTHROPIC_API_KEY_SECRET, ANTHROPIC_API_PLUGIN_ID, PLATFORM_TOOL_NAMES, createPlatformModelAgent, type PlatformAgentDeps } from '@agentic/runtimes';
import type { Policy } from '@sigx/ai-agent';
import { actor, type AnyActorDefinition } from '@sigx/actors';

import { asPrincipal, mintAgentPrincipal, userPrincipal } from '../auth/index.js';
import { sessionPolicy } from '../policy/index.js';
import { registryKey } from '../registry/key.js';
import type { ConnectorStatus, GateConnector, RegistryGate } from '../registry/types.js';
import type { OpenedSession, SessionFactory, SessionFactoryContext } from '../session/ports.js';
import type { SessionMemory } from '../task/driver.js';
import { connectorPolicy, openSessionConnectors, type ConnectorOpener } from './connectors.js';
import { createActorToolPorts, type AgentPrincipal } from './tools.js';

/** What a local runtime is handed besides the factory context: its plugin's config and the way to its secrets. */
export interface RuntimePluginAccess {
    /** The runtime plugin's config, defaults filled in — as `Registry.gate()` reported it to the router (`spec.plugins`). */
    readonly config: Readonly<Record<string, unknown>>;
    /** Whether a Registry backs `secret` — without one (a test, an app before the catalogue) a runtime falls back to its own options. */
    readonly registry: boolean;
    /**
     * A secret the runtime's manifest declares — or, with `pluginId`, one a connector plugin declares — through
     * `Registry.openSecret` (enabled + granted, audited). `undefined` when it is not set — or when the factory has
     * no `registry`. Ask once per open; never keep it.
     */
    secret(name: string, pluginId?: string): Promise<string | undefined>;
    /** The agent's connectors as the router's gate found them (`spec.plugins.connectors`, #240); empty when it names none. */
    readonly connectors: readonly GateConnector[];
    /** Record what opening a connector found (`Registry.setConnectorStatus`); absent without a `registry`. */
    reportConnector?(id: string, status: ConnectorStatus, tools?: readonly string[]): Promise<void>;
}

/** Where a runtime's sessions live: in this process, or on a machine's daemon. */
export type RuntimeImpl = { readonly host: 'local'; open(context: SessionFactoryContext, plugin: RuntimePluginAccess): Promise<OpenedSession> } | { readonly host: 'daemon' };

/** Runtime id → implementation: the build's runtimes, assembled where the app is composed. A function serves ids minted at run time. */
export type RuntimeCatalogue = Readonly<Record<string, RuntimeImpl>> | ((runtime: RuntimeId) => RuntimeImpl | undefined);

export function resolveRuntime(runtimes: RuntimeCatalogue, runtime: RuntimeId): RuntimeImpl | undefined {
    if (typeof runtimes === 'function') return runtimes(runtime);
    return Object.prototype.hasOwnProperty.call(runtimes, runtime) ? runtimes[runtime] : undefined;
}

export interface AnthropicApiRuntimeOptions {
    /** The Routing actor definition (`task_report`). */
    readonly routing: () => AnyActorDefinition;
    /** The Session actor definition (`ask_user`, #122); without it the tool answers `unsupported`. */
    readonly sessions?: () => AnyActorDefinition;
    /** A model to run every session on instead of the provider's — tests pass `mockModel`. With a `registry` the key is still required; without one, it is the only way to open. */
    readonly model?: PlatformAgentDeps['model'];
    /** The approval policy every session opens with, replacing the compiled one (`sessionPolicy(spec)`). Tests pass `allowAll`. */
    readonly policy?: Policy;
    /** Where chat attachment bytes live (#203) — the `files` port (`chat_file_read`); absent, the tool reports it unavailable. */
    readonly files?: ChatFileStore;
    /**
     * The memory `memory_search` / `memory_remember` reach (#242): the workspace's active memory plugin for the gate on
     * the spec — `(gate) => memoryAccess(learningPorts, gate)`. Absent → the Memory actor of the agent's own scope.
     */
    readonly memory?: (gate: RegistryGate | undefined) => SessionMemory;
    /**
     * Opens an MCP connector as tools (#240) — `openMcpConnector` of `@agentic/mcp`, passed where the app is composed.
     * Absent: an agent's connectors are left out of its sessions, and the agent is told why.
     */
    readonly connectors?: ConnectorOpener;
}

export interface SessionFactoryOptions extends AnthropicApiRuntimeOptions {
    /**
     * The build's runtimes. Absent: `anthropic-api` is `anthropicApiRuntime(options)` and every other id is
     * daemon-hosted, as before the catalogue. Present: an id it does not know fails the open `unknown-runtime`.
     */
    readonly runtimes?: RuntimeCatalogue;
    /** The Registry actor definition (`defineRegistry`): where a local runtime's secrets are opened. Absent → no secret is ever resolved. */
    readonly registry?: () => AnyActorDefinition;
}

export const NO_API_KEY_CODE = 'no-api-key';
export const UNKNOWN_RUNTIME_CODE = 'unknown-runtime';
export const PLUGIN_DISABLED_CODE = 'plugin-disabled';

/** Where the user sets the key — named in the `no-api-key` message. */
const ANTHROPIC_PLUGIN_PAGE = `/plugins/${ANTHROPIC_API_PLUGIN_ID}`;

/** The slice of the Registry actor a factory calls. */
interface RegistrySecrets {
    openSecret(name: string, pluginId: string): Promise<string>;
    setConnectorStatus(id: string, status: ConnectorStatus, tools?: readonly string[]): Promise<unknown>;
}

/** A Registry refusal by its stable `code` — the class does not survive a hop between objects, the code and the message do. */
function registryCode(error: unknown): string | undefined {
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string') return code;
    const message = error instanceof Error ? error.message : '';
    if (/\[registry\] no secret "/.test(message)) return 'secret-missing';
    if (/\[registry\] plugin ".*" is not installed/.test(message)) return 'plugin-missing';
    if (/\[registry\] plugin ".*" is disabled/.test(message)) return PLUGIN_DISABLED_CODE;
    return undefined;
}

/**
 * The built-in `anthropic-api` runtime (local). With a Registry behind `plugin.secret` the key is the workspace's
 * `anthropic-api-key` secret, asked for on every open — even under the `model` seam, which replaces the model only.
 */
export function anthropicApiRuntime(options: AnthropicApiRuntimeOptions): RuntimeImpl {
    return {
        host: 'local',
        async open(c, plugin) {
            const principal = mintAgentPrincipal({ workspaceId: c.workspaceId, agentId: c.spec.agentId, sessionId: c.sessionId, ...(c.spec.taskId ? { taskId: c.spec.taskId } : {}) }) as AgentPrincipal;
            const ports = createActorToolPorts({
                principal,
                ...(c.spec.chatId ? { chatId: c.spec.chatId } : {}),
                routing: options.routing,
                ...(options.sessions ? { sessions: options.sessions } : {}),
                ...(options.files ? { files: options.files } : {}),
                ...(options.memory ? { memory: options.memory(c.spec.plugins) } : {})
            });
            let provider: PlatformAgentDeps['anthropic'];
            if (plugin.registry) {
                const apiKey = await plugin.secret(ANTHROPIC_API_KEY_SECRET);
                if (!apiKey) throw new Error(`${NO_API_KEY_CODE}: workspace ${c.workspaceId} has no Anthropic API key — add one at ${ANTHROPIC_PLUGIN_PAGE}`);
                provider = { apiKey };
            } else if (!options.model) {
                // No Registry behind the factory, so no key can be found: the key is only ever the workspace's secret (#231).
                throw new Error(`${NO_API_KEY_CODE}: workspace ${c.workspaceId} has no Anthropic API key — add one at ${ANTHROPIC_PLUGIN_PAGE}`);
            }
            // The agent's MCP connectors (#240): the ready ones join the roster, the rest are named in the prompt with why.
            const connectors = await openSessionConnectors({
                connectors: plugin.connectors,
                ...(options.connectors ? { opener: options.connectors } : {}),
                secret: (name, pluginId) => plugin.secret(name, pluginId),
                ...(plugin.reportConnector ? { report: (id, status, tools) => plugin.reportConnector!(id, status, tools) } : {}),
                taken: PLATFORM_TOOL_NAMES
            });
            try {
                const built = createPlatformModelAgent(c.spec.config, {
                    ports,
                    ...(options.model ? { model: options.model } : { anthropic: provider }),
                    store: c.transcripts,
                    ...(c.spec.memories?.length ? { memories: c.spec.memories } : {}),
                    ...(c.spec.roster ? { roster: c.spec.roster } : {}),
                    ...(connectors.tools.length ? { tools: connectors.tools } : {}),
                    ...(connectors.unavailable.length ? { unavailableConnectors: connectors.unavailable } : {})
                });
                const policy = connectorPolicy(options.policy ?? sessionPolicy(c.spec), connectors.annotations);
                const session = await built.agent.session({ policy, signal: c.signal, ...(c.resume ? { resume: c.resume } : {}) });
                return {
                    session,
                    agentId: built.agent.id,
                    capabilities: built.agent.capabilities,
                    usageRow: built.usageRow,
                    dispose: async () => {
                        try {
                            await built.agent.dispose();
                        } finally {
                            await connectors.close();
                        }
                    }
                };
            } catch (e) {
                await connectors.close();
                throw e;
            }
        }
    };
}

export function createSessionFactory(options: SessionFactoryOptions): SessionFactory {
    const builtin = anthropicApiRuntime(options);
    const lookup = (runtime: RuntimeId): RuntimeImpl | undefined => {
        if (options.runtimes) return resolveRuntime(options.runtimes, runtime);
        return runtime === ANTHROPIC_API_PLUGIN_ID ? builtin : { host: 'daemon' };
    };
    return async (runtime, c) => {
        const impl = lookup(runtime);
        if (!impl) throw new Error(`${UNKNOWN_RUNTIME_CODE}: this build has no runtime "${runtime}"`);
        if (impl.host === 'daemon') return null;
        const registry = options.registry;
        // As the workspace's owner (v1: `workspaceId === userId`): the session's agent principal does not exist yet, and the Registry audits who asked.
        const client = (): RegistrySecrets => actor(registry!(), registryKey(c.workspaceId)).with({ context: asPrincipal(userPrincipal(c.workspaceId, c.workspaceId)) }) as unknown as RegistrySecrets;
        return impl.open(c, {
            config: c.spec.plugins?.runtime?.id === runtime ? c.spec.plugins.runtime.config : {},
            registry: registry !== undefined,
            connectors: c.spec.plugins?.connectors ?? [],
            ...(registry
                ? {
                      async reportConnector(id: string, status: ConnectorStatus, tools?: readonly string[]) {
                          await client().setConnectorStatus(id, status, tools);
                      }
                  }
                : {}),
            async secret(name, pluginId) {
                if (!registry) return undefined;
                if (pluginId !== undefined && pluginId !== runtime) {
                    // A connector's secret: its plugin answers for itself — missing, off or not granted is the connector's problem, never the session's.
                    try {
                        return await client().openSecret(name, pluginId);
                    } catch (e) {
                        if (registryCode(e) === 'secret-missing') return undefined;
                        throw e;
                    }
                }
                try {
                    return await client().openSecret(name, runtime);
                } catch (e) {
                    const code = registryCode(e);
                    if (code === 'secret-missing') return undefined;
                    // Both fail the task `plugin-disabled` (the router reads the prefix); the message says which it was.
                    if (code === 'plugin-missing') throw new Error(`${PLUGIN_DISABLED_CODE}: no "${runtime}" runtime plugin is installed in workspace ${c.workspaceId}`);
                    if (code === PLUGIN_DISABLED_CODE) throw new Error(`${PLUGIN_DISABLED_CODE}: the "${runtime}" runtime plugin is turned off for workspace ${c.workspaceId}`);
                    throw e;
                }
            }
        });
    };
}
