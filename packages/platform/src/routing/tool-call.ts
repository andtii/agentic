/**
 * The Machine's `ToolCallPort` (architecture §5b): a daemon session's
 * `tool.call {tool, input}` runs the SAME platform tool definition the local
 * path serves (`platformTools` from `@agentic/runtimes`), over the actor
 * ports, under the agent principal the Machine minted — so a tool answers
 * identically whether the model runs here or on a machine. The tool
 * validates its own input (`execute` throws `SchemaValidationError`), which
 * the daemon sees as `tool.result.error {code: 'invalid'}`.
 */

import type { ChatFileStore, ChatId, Principal } from '@agentic/core';
import { isPlatformToolName, platformTools } from '@agentic/runtimes';
import { actor, type AnyActorDefinition } from '@sigx/actors';

import { asPrincipal } from '../auth/index.js';
import { ToolCallError, type ToolCallPort } from '../machine/ports.js';
import type { RegistryGate } from '../registry/types.js';
import type { SessionMemory } from '../task/driver.js';
import { createActorToolPorts, type AgentPrincipal } from './tools.js';

/** The slice of the Session actor the port reads (`defineSessionActor`). */
interface SessionSpecClient {
    get(): Promise<{ readonly spec?: { readonly chatId?: ChatId; readonly plugins?: RegistryGate } }>;
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
}

/** A `tool.call` port over the actors: the Machine binds it as `MachinePorts.tools`. */
export function createToolCallPort(options: ToolCallPortOptions): ToolCallPort {
    return {
        async call(input, principal: Principal) {
            if (principal.kind !== 'agent') throw new ToolCallError('forbidden', `tool.call runs under an agent principal, not ${principal.kind}`);
            if (!isPlatformToolName(input.tool)) throw new ToolCallError('unsupported', `no platform tool named "${input.tool}"`);
            const agent = principal as AgentPrincipal;
            let chatId: ChatId | undefined;
            let memory: SessionMemory | undefined;
            const memoryTool = MEMORY_TOOLS.includes(input.tool) && options.memory !== undefined;
            if (input.tool === 'chat_post' || input.tool === 'ask_user' || memoryTool) {
                const session = actor(options.sessions(), `${agent.workspaceId}:session:${agent.sessionId}`).with({ context: asPrincipal(agent) }) as unknown as SessionSpecClient;
                const spec = (await session.get()).spec;
                chatId = spec?.chatId;
                if (memoryTool) memory = options.memory!(spec?.plugins);
            }
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
