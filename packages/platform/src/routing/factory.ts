/**
 * The concrete `SessionFactory` (architecture §5a): `anthropic-api` runs
 * in-process through `createPlatformModelAgent` over the actor tool ports;
 * every other runtime is daemon-hosted and answers `null` (the Session then
 * expects frames from a Machine). Keys are BYO (§5a): `anthropic` resolves
 * the provider options per workspace and a missing key fails the open with
 * a clear error, never a silent fallback to the deployment's environment.
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

import type { WorkspaceId } from '@agentic/core';
import { createPlatformModelAgent, type PlatformAgentDeps } from '@agentic/runtimes';
import type { Policy } from '@sigx/ai-agent';
import type { AnyActorDefinition } from '@sigx/actors';

import { mintAgentPrincipal } from '../auth/index.js';
import { sessionPolicy } from '../policy/index.js';
import type { SessionFactory } from '../session/ports.js';
import { createActorToolPorts, type AgentPrincipal } from './tools.js';

export interface SessionFactoryOptions {
    /** The Routing actor definition (`task_report`). */
    readonly routing: () => AnyActorDefinition;
    /** The Session actor definition (`ask_user`, #122); without it the tool answers `unsupported`. */
    readonly sessions?: () => AnyActorDefinition;
    /** The workspace's Anthropic provider options (BYO key). Absent or without `apiKey` → the open fails. */
    readonly anthropic?: (workspaceId: WorkspaceId) => PlatformAgentDeps['anthropic'] | Promise<PlatformAgentDeps['anthropic']>;
    /** A model to run every session on instead of the provider — tests pass `mockModel`. */
    readonly model?: PlatformAgentDeps['model'];
    /** The approval policy every session opens with, replacing the compiled one (`sessionPolicy(spec)`). Tests pass `allowAll`. */
    readonly policy?: Policy;
}

export const NO_API_KEY_CODE = 'no-api-key';

export function createSessionFactory(options: SessionFactoryOptions): SessionFactory {
    return async (runtime, c) => {
        if (runtime !== 'anthropic-api') return null;
        const principal = mintAgentPrincipal({ workspaceId: c.workspaceId, agentId: c.spec.agentId, sessionId: c.sessionId, ...(c.spec.taskId ? { taskId: c.spec.taskId } : {}) }) as AgentPrincipal;
        const ports = createActorToolPorts({ principal, ...(c.spec.chatId ? { chatId: c.spec.chatId } : {}), routing: options.routing, ...(options.sessions ? { sessions: options.sessions } : {}) });
        let provider: PlatformAgentDeps['anthropic'];
        if (!options.model) {
            provider = await options.anthropic?.(c.workspaceId);
            if (!provider?.apiKey && !provider?.client) throw new Error(`${NO_API_KEY_CODE}: workspace ${c.workspaceId} has no Anthropic API key configured`);
        }
        const built = createPlatformModelAgent(c.spec.config, {
            ports,
            ...(options.model ? { model: options.model } : { anthropic: provider }),
            store: c.transcripts,
            ...(c.spec.memories?.length ? { memories: c.spec.memories } : {})
        });
        const session = await built.agent.session({ policy: options.policy ?? sessionPolicy(c.spec), signal: c.signal, ...(c.resume ? { resume: c.resume } : {}) });
        return {
            session,
            agentId: built.agent.id,
            capabilities: built.agent.capabilities,
            usageRow: built.usageRow,
            dispose: () => built.agent.dispose()
        };
    };
}
