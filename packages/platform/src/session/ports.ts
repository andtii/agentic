/**
 * Ports the Session actor is composed with (architecture §4 Session, §5a/§5b).
 *
 * The actor never imports a runtime adapter: a `SessionFactory` turns a
 * runtime id into a live `AgentSession` (the platform-managed path), and a
 * `CommandSink` carries wire commands to the machine that hosts a daemon
 * session (the daemon path). Tests plug `mockAgent`; apps plug
 * `@agentic/runtimes` and the Machine actor.
 */

import type { AgentId, ChatId, EnvironmentId, FrozenAgentConfig, MachineId, RuntimeId, SessionId, TaskId, WorkspaceId } from '@agentic/core';
import type { AgentCapabilities, AgentSession, SessionRef, TranscriptStore } from '@sigx/ai-agent';
import type { WireCommand } from '@sigx/ai-agent/wire';

/** What `Session.open` is handed — everything a factory needs to open the runtime session. Plain JSON: it is recorded on the actor. */
export interface SessionOpenSpec {
    readonly agentId: AgentId;
    readonly runtime: RuntimeId;
    readonly chatId?: ChatId;
    readonly taskId?: TaskId;
    readonly environmentId?: EnvironmentId;
    /** Set on the daemon path: the machine whose daemon hosts the runtime session. */
    readonly machineId?: MachineId;
    /** The agent configuration this session runs with (AGT-06/07). */
    readonly config: FrozenAgentConfig;
    /** The assembled system prompt (instructions + skills + retrieved memory), when the caller built one. */
    readonly system?: string;
    /** Tool names the runtime must serve. */
    readonly tools?: readonly string[];
    /** Resume an earlier runtime session. */
    readonly resume?: SessionRef;
}

/** What the factory receives besides the runtime id. */
export interface SessionFactoryContext {
    /** The actor key, `{ws}:session:{id}`. */
    readonly key: string;
    readonly workspaceId: WorkspaceId;
    readonly sessionId: SessionId;
    readonly spec: SessionOpenSpec;
    /** The ref recorded on the actor (from `spec.resume` or an earlier activation) — hand it to `session({ resume })`. */
    readonly resume?: SessionRef;
    /** Aborts when the activation goes away; pass it as the session's `signal`. */
    readonly signal: AbortSignal;
    /** Transcript snapshots over the actor's state, for `modelAgent({ store })`. */
    readonly transcripts: TranscriptStore;
}

/** A runtime session the actor drives in-process. */
export interface OpenedSession {
    readonly session: AgentSession;
    /** The `Agent.id` (`'sigx'`, `'mock'`, …) — for the wire hello and logs, never for branching. */
    readonly agentId: string;
    readonly capabilities: AgentCapabilities;
    /** Release the agent behind the session, if the factory created one per session. */
    dispose?(): Promise<void>;
}

/**
 * Runtime id → a live session, or `null` when the runtime is not
 * platform-managed (a daemon hosts it and events arrive as wire frames).
 */
export type SessionFactory = (runtime: RuntimeId, context: SessionFactoryContext) => Promise<OpenedSession | null> | OpenedSession | null;

/** Where a daemon session's commands go — the Machine actor's `sendCommand` in the app. */
export interface CommandSink {
    send(target: { readonly workspaceId: WorkspaceId; readonly machineId: MachineId; readonly sessionId: SessionId }, command: WireCommand): Promise<void>;
}

export interface SessionPorts {
    readonly factory: SessionFactory;
    /** Required for the daemon path; without it a remote command is refused as `unsupported`. */
    readonly commands?: CommandSink;
    /** Clock, for timestamps on records that are not events. Default `Date.now`. */
    readonly now?: () => number;
}
