/**
 * The platform tool ports over the actors (architecture §5a/§5b): what
 * `memory_search`, `memory_remember`, `chat_post` and `task_report` do when
 * an agent calls them — on the local path from inside `modelAgent`, on the
 * daemon path from the Machine's `tool.call`. Every hop is a FRESH actor
 * call under the agent principal (`mintAgentPrincipal`), never a `ctx.actor`
 * hop: a tool runs outside any turn (a detached driver, a socket callback),
 * and Memory / Chat / Task authorize the agent, not whoever opened the
 * session.
 *
 * `delegate` and `ask_user` stay `unsupported` until #39 (delegation
 * semantics) — the error says so, the tool never silently succeeds.
 */

import type { ChatId, MemoryEntry, Principal, TaskId, WorkspaceId } from '@agentic/core';
import type { PlatformPorts, TaskReport } from '@agentic/runtimes';
import { actor, type ActorClientWith, type AnyActorDefinition } from '@sigx/actors';

import { agentMemoryScope } from '../agent/index.js';
import { asPrincipal } from '../auth/index.js';
import { Chat } from '../chat/index.js';
import { ToolCallError } from '../machine/ports.js';
import { Memory, memoryActorKey } from '../memory/index.js';
import { routingKey } from './key.js';

export type AgentPrincipal = Extract<Principal, { kind: 'agent' }>;

/** The slice of the Routing actor a tool port calls (`defineRoutingActor`). */
interface RoutingReportClient {
    report(taskId: TaskId, report: TaskReport): Promise<void>;
}

export interface ActorToolPortsOptions {
    /** Whose tools these are — the session's agent principal (workspace, agent, session, task?). */
    readonly principal: AgentPrincipal;
    /** The chat the session belongs to; without one `chat_post` is refused. */
    readonly chatId?: ChatId;
    /** The Routing actor definition, for `task_report`; without it the report is refused. */
    readonly routing?: () => AnyActorDefinition;
}

export function agentChatKey(workspaceId: WorkspaceId, chatId: ChatId): string {
    return `${workspaceId}:chat:${chatId}`;
}

/** The tool ports of one agent session, bound to the actors. */
export function createActorToolPorts(options: ActorToolPortsOptions): PlatformPorts {
    const { principal, chatId } = options;
    const { workspaceId, agentId, sessionId, taskId } = principal;
    const as = <D extends AnyActorDefinition>(def: D, key: string): ActorClientWith<D> => actor(def, key).with({ context: asPrincipal(principal) }) as ActorClientWith<D>;
    const memory = () => as(Memory, memoryActorKey(workspaceId, agentMemoryScope(agentId)));

    return {
        memory: {
            search: (query) => memory().query(query),
            remember: (entry): Promise<MemoryEntry> =>
                memory().put({
                    ...entry,
                    provenance: { ...entry.provenance, ...(sessionId ? { sessionId } : {}), ...(taskId ? { taskId } : {}) }
                })
        },
        chat: {
            async post(post) {
                if (!chatId) throw new ToolCallError('unsupported', 'chat_post: this session belongs to no chat');
                const result = await as(Chat, agentChatKey(workspaceId, chatId)).post(post.text, post.mentions, taskId ? { taskId } : {});
                return { messageId: result.messageId };
            },
            ask() {
                return Promise.reject(new ToolCallError('unsupported', 'ask_user: not available until delegation and input requests land (#39)'));
            }
        },
        task: {
            delegate() {
                return Promise.reject(new ToolCallError('unsupported', 'delegate: delegation semantics land with #39'));
            },
            async report(report) {
                if (!taskId) throw new ToolCallError('unsupported', 'task_report: this session works no task');
                const def = options.routing?.();
                if (!def) throw new ToolCallError('unsupported', 'task_report: the router is not wired on this deployment');
                const routing = actor(def, routingKey(workspaceId)).with({ context: asPrincipal(principal) }) as unknown as RoutingReportClient;
                await routing.report(taskId, report);
            }
        }
    };
}
