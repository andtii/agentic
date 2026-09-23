/**
 * The Machine's `ToolCallPort` (architecture §5b): a daemon session's
 * `tool.call {tool, input}` runs the SAME platform tool definition the local
 * path serves (`platformTools` from `@agentic/runtimes`), over the actor
 * ports, under the agent principal the Machine minted — so a tool answers
 * identically whether the model runs here or on a machine. The tool
 * validates its own input (`execute` throws `SchemaValidationError`), which
 * the daemon sees as `tool.result.error {code: 'invalid'}`.
 *
 * One call is not a tool at all: `CONNECTOR_CREDENTIALS_TOOL` (#280), which
 * the daemon makes itself while it opens a session, for the credential VALUES
 * of a connector that session's gate named. It is answered from the Registry
 * and recorded nowhere.
 *
 * Two more are the platform-run connectors' (#534, conduit): `CONNECTOR_TOOLS_TOOL`,
 * the daemon's own ask at open for their tool declarations, and
 * `CONNECTOR_CALL_TOOL`, one call of such a tool. Both answer only for a
 * connector the calling session's gate names as ready, and run through the
 * app's `ConnectorOpener` with the same `ConnectorOpenContext` a local session
 * has: the session's agent principal, the plugin's secrets as the owner.
 */

import { CONNECTOR_CALL_TOOL, CONNECTOR_CREDENTIALS_TOOL, CONNECTOR_TOOLS_TOOL, type ChatFileStore, type ChatId, type Principal, type TaskId } from '@agentic/core';
import { isPlatformToolName, platformTools } from '@agentic/runtimes';
import { actor, type AnyActorDefinition } from '@sigx/actors';

import { asPrincipal, mintAgentPrincipal, userPrincipal } from '../auth/index.js';
import { ToolCallError, type ToolCallPort } from '../machine/ports.js';
import { registryKey } from '../registry/key.js';
import type { ConnectorStatus, RegistryGate } from '../registry/types.js';
import type { SessionMemory } from '../task/driver.js';
import { callPlatformConnector, connectorCredentials, ConnectorCredentialsError, platformConnectorTools, PlatformConnectorError, type ConnectorOpenContext, type ConnectorOpener } from './connectors.js';
import { registryCode } from './factory.js';
import { createActorToolPorts, type AgentPrincipal } from './tools.js';

/** The slice of the Session actor the port reads (`defineSessionActor`): the spec, and the running turn for its task (#390). */
interface SessionSpecClient {
    get(): Promise<{ readonly spec?: { readonly chatId?: ChatId; readonly taskId?: TaskId; readonly plugins?: RegistryGate }; readonly running?: { readonly taskId?: TaskId } }>;
}

const MEMORY_TOOLS: readonly string[] = ['memory_search', 'memory_remember'];

export interface ToolCallPortOptions {
    /** The Routing actor definition (`task_report`). */
    readonly routing: () => AnyActorDefinition;
    /** `ask_user`'s quick-answer window in a chat (#285); default `ASK_QUICK_WAIT_MS`. */
    readonly askQuickWaitMs?: number;
    /** The Session actor definition — where a session's chat is looked up for `chat_post` and `ask_user` (#285), and where `ask_user` raises its request (#122). */
    readonly sessions: () => AnyActorDefinition;
    /** Where chat attachment bytes live (#203) — the `files` port (`chat_file_read`); absent, the tool reports it unavailable. */
    readonly files?: ChatFileStore;
    /**
     * The memory the memory tools reach (#242), for the gate recorded on the calling session's spec — read from the
     * Session only for a memory tool. Absent → the Memory actor of the agent's own scope.
     */
    readonly memory?: (gate: RegistryGate | undefined) => SessionMemory;
    /** The Machine actor definition — `usage_limits` (#272); absent, the tool reports it unavailable. */
    readonly machines?: () => AnyActorDefinition;
    /** The Registry actor definition — where a daemon's connector credentials are opened (#280); absent, it gets none. */
    readonly registry?: () => AnyActorDefinition;
    /**
     * The app's connector opener — the one `anthropicApiRuntime` is handed (#534): a daemon-hosted session's conduit
     * connectors run through it here, on the platform. Absent (or without `registry`), a daemon session gets none.
     */
    readonly connectors?: ConnectorOpener;
}

/** The slice of the Registry actor the credentials answer calls. */
interface RegistryConnectorSecrets {
    openSecret(name: string, pluginId: string): Promise<string>;
    setConnectorStatus(id: string, status: ConnectorStatus, tools?: readonly string[]): Promise<unknown>;
}

/** A `tool.call` port over the actors: the Machine binds it as `MachinePorts.tools`. */
export function createToolCallPort(options: ToolCallPortOptions): ToolCallPort {
    /** The daemon's own call for a connector's credential values (#280): only one the calling session's gate named. */
    async function credentials(input: unknown, agent: AgentPrincipal): Promise<unknown> {
        const connectorId = (input as { connectorId?: unknown } | null)?.connectorId;
        if (typeof connectorId !== 'string' || connectorId === '') throw new ToolCallError('invalid', `${CONNECTOR_CREDENTIALS_TOOL}: connectorId is required`);
        if (!options.registry) throw new ToolCallError('unsupported', 'connector credentials are not wired on this deployment');
        const session = actor(options.sessions(), `${agent.workspaceId}:session:${agent.sessionId}`).with({ context: asPrincipal(agent) }) as unknown as SessionSpecClient;
        const gate = (await session.get()).spec?.plugins;
        // As the workspace's owner, as a local session's connectors are opened: the Registry audits who asked.
        const registry = actor(options.registry(), registryKey(agent.workspaceId)).with({ context: asPrincipal(userPrincipal(agent.workspaceId, agent.workspaceId)) }) as unknown as RegistryConnectorSecrets;
        try {
            return await connectorCredentials({
                connectors: gate?.connectors ?? [],
                connectorId,
                async secret(name, pluginId) {
                    try {
                        return await registry.openSecret(name, pluginId);
                    } catch (e) {
                        if (registryCode(e) === 'secret-missing') return undefined;
                        throw e;
                    }
                },
                report: async (id, status) => {
                    await registry.setConnectorStatus(id, status);
                }
            });
        } catch (e) {
            if (e instanceof ConnectorCredentialsError) throw new ToolCallError(e.code === 'not-named' ? 'forbidden' : 'invalid', e.message);
            throw e;
        }
    }

    /** The calling session's gate, and the Registry as the owner — what a connector call is checked against and opened with. */
    async function connectorAccess(agent: AgentPrincipal): Promise<{ gate: RegistryGate | undefined; registry: RegistryConnectorSecrets }> {
        const session = actor(options.sessions(), `${agent.workspaceId}:session:${agent.sessionId}`).with({ context: asPrincipal(agent) }) as unknown as SessionSpecClient;
        const gate = (await session.get()).spec?.plugins;
        const registry = actor(options.registry!(), registryKey(agent.workspaceId)).with({ context: asPrincipal(userPrincipal(agent.workspaceId, agent.workspaceId)) }) as unknown as RegistryConnectorSecrets;
        return { gate, registry };
    }

    /** A local session's `ConnectorOpenContext`, for a daemon session: its agent principal, the plugin's secrets as the owner. */
    function openContext(agent: AgentPrincipal, registry: RegistryConnectorSecrets): ConnectorOpenContext {
        return {
            workspaceId: agent.workspaceId,
            principal: agent,
            async secret(name, pluginId) {
                try {
                    return await registry.openSecret(name, pluginId);
                } catch (e) {
                    if (registryCode(e) === 'secret-missing') return undefined;
                    throw e;
                }
            }
        };
    }

    /** The daemon's own ask at open (#534): the declarations of the session's platform-run connectors. */
    async function connectorTools(agent: AgentPrincipal): Promise<unknown> {
        // Not wired: the session simply has none, as on a platform that predates the call.
        if (!options.registry || !options.connectors) return { connectors: [], unavailable: [] };
        const { gate, registry } = await connectorAccess(agent);
        return platformConnectorTools({
            connectors: gate?.connectors ?? [],
            opener: options.connectors,
            context: openContext(agent, registry),
            report: async (id, status, tools) => {
                await registry.setConnectorStatus(id, status, tools);
            }
        });
    }

    /** One call of a platform-run connector's tool (#534), for a connector the calling session's gate names. */
    async function connectorCall(input: unknown, agent: AgentPrincipal, callId: string): Promise<unknown> {
        const call = (input ?? {}) as { connectorId?: unknown; tool?: unknown; input?: unknown };
        if (typeof call.connectorId !== 'string' || call.connectorId === '' || typeof call.tool !== 'string' || call.tool === '') {
            throw new ToolCallError('invalid', `${CONNECTOR_CALL_TOOL}: connectorId and tool are required`);
        }
        if (!options.registry || !options.connectors) throw new ToolCallError('unsupported', 'platform connectors are not wired on this deployment');
        const { gate, registry } = await connectorAccess(agent);
        try {
            return await callPlatformConnector({
                connectors: gate?.connectors ?? [],
                connectorId: call.connectorId,
                tool: call.tool,
                input: call.input ?? {},
                callId,
                opener: options.connectors,
                context: openContext(agent, registry)
            });
        } catch (e) {
            if (e instanceof PlatformConnectorError) throw new ToolCallError(e.code === 'not-named' ? 'forbidden' : e.code, e.message);
            throw e;
        }
    }

    return {
        async call(input, principal: Principal) {
            if (principal.kind !== 'agent') throw new ToolCallError('forbidden', `tool.call runs under an agent principal, not ${principal.kind}`);
            if (input.tool === CONNECTOR_CREDENTIALS_TOOL) return credentials(input.input, principal as AgentPrincipal);
            if (input.tool === CONNECTOR_TOOLS_TOOL) return connectorTools(principal as AgentPrincipal);
            if (input.tool === CONNECTOR_CALL_TOOL) return connectorCall(input.input, principal as AgentPrincipal, input.callId);
            if (!isPlatformToolName(input.tool)) throw new ToolCallError('unsupported', `no platform tool named "${input.tool}"`);
            const minted = principal as AgentPrincipal;
            // One Session hop per call (#390): the Machine minted the principal from the task the session was OPENED for, but the
            // turn owns the task — the running turn's (else the spec's) is what every tool below attributes to. The same read
            // gives `chat_post` / `ask_user` their chat and the memory tools their gate.
            const session = actor(options.sessions(), `${minted.workspaceId}:session:${minted.sessionId}`).with({ context: asPrincipal(minted) }) as unknown as SessionSpecClient;
            const info = await session.get();
            const taskId = info.running?.taskId ?? info.spec?.taskId;
            const agent = taskId === minted.taskId ? minted : (mintAgentPrincipal({ workspaceId: minted.workspaceId, agentId: minted.agentId, sessionId: minted.sessionId, ...(taskId ? { taskId } : {}) }) as AgentPrincipal);
            const chatId: ChatId | undefined = info.spec?.chatId;
            const memory: SessionMemory | undefined = MEMORY_TOOLS.includes(input.tool) && options.memory !== undefined ? options.memory(info.spec?.plugins) : undefined;
            const ports = createActorToolPorts({
                principal: agent,
                ...(chatId ? { chatId } : {}),
                routing: options.routing,
                sessions: options.sessions,
                ...(options.files ? { files: options.files } : {}),
                ...(memory ? { memory } : {}),
                ...(options.machines ? { machines: options.machines } : {}),
                ...(options.askQuickWaitMs !== undefined ? { askQuickWaitMs: options.askQuickWaitMs } : {})
            });
            const tool = platformTools(ports).find((t) => t.name === input.tool);
            if (!tool) throw new ToolCallError('unsupported', `no platform tool named "${input.tool}"`);
            try {
                return await tool.run(input.input, { toolCallId: input.callId, signal: new AbortController().signal });
            } catch (e) {
                if (e instanceof ToolCallError) throw e;
                if (e instanceof Error && e.name === 'SchemaValidationError') throw new ToolCallError('invalid', e.message);
                throw e;
            }
        }
    };
}
