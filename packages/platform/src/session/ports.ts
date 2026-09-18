/**
 * Ports the Session actor is composed with (architecture §4 Session, §5a/§5b).
 *
 * The actor never imports a runtime adapter: a `SessionFactory` turns a
 * runtime id into a live `AgentSession` (the platform-managed path), and a
 * `CommandSink` carries wire commands to the machine that hosts a daemon
 * session (the daemon path). Tests plug `mockAgent`; apps plug
 * `@agentic/runtimes` and the Machine actor.
 */

import type { AgentId, ApprovalRule, ChatId, EnvironmentId, FrozenAgentConfig, MachineId, MemoryEntry, MemoryScope, PromptPart, RuntimeId, SessionId, TaskId, Usage, UsageRow, WorkspaceId } from '@agentic/core';
import type { AnyActorDefinition } from '@sigx/actors';
import type { AgentCapabilities, AgentSession, SessionRef, TranscriptStore } from '@sigx/ai-agent';
import type { WireCommand } from '@sigx/ai-agent/wire';
import type { LearningPorts, SkippedScope } from '../task/driver.js';

/** How the memory block of a session was retrieved — recorded on the spec (MEM-10: the supply path is visible). */
export interface MemoryRetrievalRecord {
    /** The query text the scopes were ranked on. */
    readonly text: string;
    readonly scopes: readonly MemoryScope[];
    /** Scopes that answered nothing because the agent may not read them, or failed. */
    readonly skipped: readonly SkippedScope[];
    readonly at: number;
}

import type { AuditPort } from '../audit/port.js';
import type { UsageRecorder } from '../ledger/recorder.js';

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
    /**
     * Set by the router on a delegated task's session: the approval rules of every ancestor task's
     * agent, oldest first. The session's policy is its own constrained by these — never wider (AC-12).
     */
    readonly approvalConstraints?: readonly ApprovalRule[];
    /** The task objective the session starts on — what memory retrieval ranks on and learning records (MEM-07, LRN-05). */
    readonly objective?: string;
    /** The prompt parts the work starts from (the task's context); the last text part is the latest user message. */
    readonly context?: readonly PromptPart[];
    /** Tags retrieval filters on and learning stamps on records. */
    readonly tags?: readonly string[];
    /**
     * The assembled system prompt (instructions + skills), when the caller built one (the daemon path).
     * When the actor has learning ports, `open` appends the retrieved memory block (`## Platform memory`)
     * to it. Without one nothing is composed here: `memories` is what the runtime renders (#135).
     */
    readonly system?: string;
    /** Filled by `open`: the memories retrieved for this session, in rank order — the API factory renders them natively (`createPlatformModelAgent({ memories })`), the one place on the local path. */
    readonly memories?: readonly MemoryEntry[];
    /** Filled by `open`: how `memories` were retrieved. */
    readonly retrieval?: MemoryRetrievalRecord;
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
    /**
     * Price a `usage` event as a Ledger row (OPS-07) — `createPlatformModelAgent(...).usageRow`
     * on the API path, with `estimated: true` when the rate was a guess. Without it the driver
     * records the event's own `costUsd` as reported, or the row as unpriced when there is none.
     */
    usageRow?(event: { readonly usage?: Usage; readonly costUsd?: number }, at: { readonly sessionId: string; readonly taskId?: string; readonly at: number }): UsageRow;
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
    /** Where turn-scoped `usage` events go (the Ledger, OPS-07) and who says when the task's budget is spent (OPS-08); `ledgerRecorder()` in the app. */
    readonly usage?: UsageRecorder;
    /**
     * Memory and learning (architecture §8): `open` retrieves the agent's memories into the spec,
     * every finished turn of a task session goes through `plugin.onTaskEnd`, and `correct` through
     * `plugin.onCorrection`. Without it the session neither retrieves nor learns.
     */
    readonly learning?: LearningPorts;
    /** Where permission requests and their decisions are recorded (`approval.*`, OPS-03). Default `auditPort()` — one-way to `{ws}:audit`. */
    readonly audit?: AuditPort;
    /**
     * The Inbox actor definition (`defineInbox`), when the app has one: every `request` the session
     * raises — both paths, task or chat — becomes an `approval` / `input` notification with a session
     * ref, and its `request-resolved` marks that notification read (OPS-02). Best effort, one-way.
     */
    readonly inbox?: () => AnyActorDefinition;
    /** Clock, for timestamps on records that are not events. Default `Date.now`. */
    readonly now?: () => number;
}
