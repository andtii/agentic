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
import { createActorToolPorts, type AgentPrincipal } from './tools.js';

/** The slice of the Session actor the port reads (`defineSessionActor`). */
interface SessionSpecClient {
    get(): Promise<{ readonly spec?: { readonly chatId?: ChatId } }>;
}

export interface ToolCallPortOptions {
    /** The Routing actor definition (`task_report`). */
    readonly routing: () => AnyActorDefinition;
    /** The Session actor definition — where a session's chat is looked up for `chat_post`, and where `ask_user` raises its request (#122). */
    readonly sessions: () => AnyActorDefinition;
    /** Where chat attachment bytes live (#203) — the `files` port (`chat_file_read`); absent, the tool reports it unavailable. */
    readonly files?: ChatFileStore;
}

/** A `tool.call` port over the actors: the Machine binds it as `MachinePorts.tools`. */
export function createToolCallPort(options: ToolCallPortOptions): ToolCallPort {
    return {
        async call(input, principal: Principal) {
            if (principal.kind !== 'agent') throw new ToolCallError('forbidden', `tool.call runs under an agent principal, not ${principal.kind}`);
            if (!isPlatformToolName(input.tool)) throw new ToolCallError('unsupported', `no platform tool named "${input.tool}"`);
            const agent = principal as AgentPrincipal;
            let chatId: ChatId | undefined;
            if (input.tool === 'chat_post') {
                const session = actor(options.sessions(), `${agent.workspaceId}:session:${agent.sessionId}`).with({ context: asPrincipal(agent) }) as unknown as SessionSpecClient;
                chatId = (await session.get()).spec?.chatId;
            }
            const ports = createActorToolPorts({ principal: agent, ...(chatId ? { chatId } : {}), routing: options.routing, sessions: options.sessions, ...(options.files ? { files: options.files } : {}) });
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
