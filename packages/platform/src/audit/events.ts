/**
 * The audit event catalogue (architecture §4 Audit; OPS-03, COL-09,
 * AGT-06): every consequential action the platform takes is one event of a
 * listed kind, emitted ONCE per occurrence by the actor that performs it and
 * folded idempotently by its `key`.
 *
 * Common fields say who, when and on whose behalf (`by`, `at`, `agentId?`,
 * `taskId?`, `sessionId?`) plus a one-line `summary` for the history page;
 * `data` carries the kind's own facts as plain JSON. The shapes here are the
 * contract the history page and other emitters (delegation, #39) build on.
 */

import type { AgentId, EnvironmentId, Limits, MachineId, OfflinePolicy, PermissionScope, RuntimeId, SessionId, TaskId, TaskStatus, WaitReason } from '@agentic/core';

export const AUDIT_KINDS = [
    'approval.requested',
    'approval.resolved',
    'delegation.created',
    'environment.chosen',
    'task.transition',
    'config.versioned',
    'proposal.reviewed',
    'machine.paired',
    'machine.revoked',
    'plugin.enabled',
    'plugin.disabled',
    'plugin.granted',
    'secret.opened'
] as const;

export type AuditKind = (typeof AUDIT_KINDS)[number];

const KINDS: ReadonlySet<string> = new Set<string>(AUDIT_KINDS);

export function isAuditKind(value: unknown): value is AuditKind {
    return typeof value === 'string' && KINDS.has(value);
}

/** What every event carries, whatever its kind. */
export interface AuditEventBase {
    /**
     * Idempotency key, unique per occurrence and derived from the source record
     * (`{taskKey}:transition:{n}`, `{sessionKey}:{epoch}:{seq}`, …) so a retried
     * turn or a replayed log folds once.
     */
    readonly key: string;
    /** Epoch milliseconds, the emitter's clock. Decides the archive month. */
    readonly at: number;
    /** Who acted: `user:<id>`, `agent:<id>`, `machine:<id>`, `external:<clientId>`, `system:<name>`. */
    readonly by: string;
    /** One line for the history page. */
    readonly summary: string;
    /** The agent the action concerns (the task's assignee, the configured agent, the requesting session's agent). */
    readonly agentId?: AgentId;
    readonly taskId?: TaskId;
    readonly sessionId?: SessionId;
}

/** A permission request the session raised (`request {kind: 'permission'}`), keyed by the event's `(epoch, seq)`. */
export interface ApprovalRequestedData {
    readonly requestId: string;
    readonly toolName?: string;
    readonly callId?: string;
    readonly message?: string;
    readonly permissionKey?: string;
}

/** How a permission request settled — a user's decision, a policy rule, a timeout or a cancel. */
export interface ApprovalResolvedData {
    readonly requestId: string;
    readonly outcome: 'allow' | 'deny' | 'input' | 'cancel';
    /** The wire's `ResolvedBy`: `client` (a human through `Session.respond`), `policy`, `timeout`, `cancel`. */
    readonly resolvedBy: string;
    readonly scope?: 'once' | 'session';
    readonly reason?: string;
    readonly ruleId?: string;
}

/**
 * `Task.delegate` created a child (COL-04/09). `taskId` is the PARENT; the
 * child is `data.childTaskId` (`list({ taskId: child })` matches it too).
 * The one `delegation.*` shape — the DelegateTool (#39) calls `Task.delegate`
 * and emits nothing of its own.
 */
export interface DelegationCreatedData {
    readonly parentTaskId: TaskId;
    readonly childTaskId: TaskId;
    /** The agent the child is assigned to. */
    readonly assignee: AgentId;
    /** The agent responsible for the outcome (the delegating agent by default). */
    readonly owner: AgentId;
    readonly objective: string;
    /** The tool call id the child id was derived from. */
    readonly callId: string;
    /** The limits the child was given after the budget split — never wider than the parent's remainder. */
    readonly constraints: Limits;
    readonly environmentId?: EnvironmentId;
}

/**
 * Where the router decided a task runs (EXE-11/12): once at `run`, and again
 * with `fallback: true` when the agent's `fallback-api` policy moved the task
 * off its offline environment — `from` says what it left.
 */
export interface EnvironmentChosenData {
    readonly runtime: RuntimeId;
    readonly environmentId?: EnvironmentId;
    readonly policy: OfflinePolicy;
    readonly fallback: boolean;
    readonly from?: { readonly runtime: RuntimeId; readonly environmentId?: EnvironmentId; readonly machineId?: MachineId };
    readonly why: string;
}

/** One edge of the task state machine, as the Task recorded it. */
export interface TaskTransitionData {
    readonly from: TaskStatus;
    readonly to: TaskStatus;
    readonly why: string;
    readonly wait?: WaitReason;
}

/** A new agent config version (AGT-06): an update, a rollback, or an accepted proposal. */
export interface ConfigVersionedData {
    readonly version: number;
    readonly reason: string;
    readonly rollbackOf?: number;
}

/** A user reviewed an instruction proposal (LRN-08); `version` is the config version an acceptance produced. */
export interface ProposalReviewedData {
    readonly proposalId: string;
    readonly decision: 'accept' | 'reject';
    readonly reason?: string;
    readonly version?: number;
}

export interface MachinePairedData {
    readonly machineId: MachineId;
    readonly name: string;
    readonly os?: string;
    readonly daemonVersion?: string;
}

export interface MachineRevokedData {
    readonly machineId: MachineId;
    readonly name: string;
}

export interface PluginToggledData {
    readonly pluginId: string;
}

/** `Registry.grant` widened a plugin's permissions; `scopes` are the ones NEWLY granted. */
export interface PluginGrantedData {
    readonly pluginId: string;
    readonly scopes: readonly PermissionScope[];
}

/** A secret's plaintext left the Registry (`openSecret`) — every call is an occurrence. */
export interface SecretOpenedData {
    readonly name: string;
    readonly pluginId: string;
}

/** The per-kind payload. */
export interface AuditDataByKind {
    readonly 'approval.requested': ApprovalRequestedData;
    readonly 'approval.resolved': ApprovalResolvedData;
    readonly 'delegation.created': DelegationCreatedData;
    readonly 'environment.chosen': EnvironmentChosenData;
    readonly 'task.transition': TaskTransitionData;
    readonly 'config.versioned': ConfigVersionedData;
    readonly 'proposal.reviewed': ProposalReviewedData;
    readonly 'machine.paired': MachinePairedData;
    readonly 'machine.revoked': MachineRevokedData;
    readonly 'plugin.enabled': PluginToggledData;
    readonly 'plugin.disabled': PluginToggledData;
    readonly 'plugin.granted': PluginGrantedData;
    readonly 'secret.opened': SecretOpenedData;
}

/** What an emitter hands `record` / `recordAudit`: one kind, its data, the common fields. */
export type AuditEventInput = {
    [K in AuditKind]: AuditEventBase & { readonly kind: K; readonly data: AuditDataByKind[K] };
}[AuditKind];

/** An event as the log keeps it: the input plus its position `seq`, the cursor `list` pages by. */
export type AuditEvent = AuditEventInput & { readonly seq: number };

/** `record` refuses anything that is not a well-formed event of a known kind — a one-way emit drops it, never the turn. */
export function assertAuditEvent(event: unknown): asserts event is AuditEventInput {
    const e = event as Partial<AuditEventBase & { kind: unknown; data: unknown }> | null;
    if (!e || typeof e !== 'object') throw new TypeError('audit: an event must be an object');
    if (typeof e.key !== 'string' || !e.key) throw new TypeError('audit: an event needs a key');
    if (!isAuditKind(e.kind)) throw new TypeError(`audit: unknown event kind ${String(e.kind)}`);
    if (typeof e.at !== 'number' || !Number.isFinite(e.at)) throw new TypeError(`audit: event ${e.key} needs an instant`);
    if (typeof e.by !== 'string' || !e.by) throw new TypeError(`audit: event ${e.key} needs a by`);
    if (typeof e.summary !== 'string') throw new TypeError(`audit: event ${e.key} needs a summary`);
    if (!e.data || typeof e.data !== 'object') throw new TypeError(`audit: event ${e.key} needs data`);
}
