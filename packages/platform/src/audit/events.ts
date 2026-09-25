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

import type { AccountKey, AgentId, ChatId, EnvErrorCode, EnvironmentId, Limits, MachineId, OfflinePolicy, PermissionScope, ProjectFeatureReleaseReason, ProjectId, ReleaseChannel, RuntimeId, SessionClosedCode, SessionId, TaskId, TaskStatus, ToolMode, UpdatePolicy, WaitReason } from '@agentic/core';

export const AUDIT_KINDS = [
    'approval.requested',
    'approval.resolved',
    'chat.project-set',
    'chat.machine-set',
    'delegation.created',
    'environment.chosen',
    'environment.put',
    'environment.removed',
    'harness.changed',
    'task.transition',
    'config.versioned',
    'connector.connected',
    'connector.disconnected',
    'connector.needs-reauth',
    'proposal.reviewed',
    'machine.paired',
    'machine.revoked',
    'machine.update-requested',
    'machine.updated',
    'machine.update-failed',
    'machine.channel-set',
    'machine.update-policy-set',
    'machine.policy-set',
    'machine.renamed',
    'machine.restart-requested',
    'machine.restarted',
    'machine.login',
    'auth.elevated',
    'plugin.enabled',
    'plugin.disabled',
    'plugin.granted',
    'plugin.revoked',
    'plugin.tool-policy',
    'plugin.activated',
    'project.changed',
    'project.chat-released',
    'secret.opened',
    'session.interrupted',
    'session.resumed',
    'task.machine-lost',
    'workdir.worktree-created',
    'workdir.command-run',

    'pull.merged',
    'pull.closed',

    // slot #750 plan audit kinds — replace this line

    // slot #758 requests audit kinds — replace this line
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
    /** The folder the session runs in (#190) — absent on `anthropic-api`, or when no machine reported the environment yet (then the first root is taken at placement). */
    readonly cwd?: string;
    /** A folder the task asked for that this runtime does not use: `anthropic-api` runs no local folder (#190) — or that came with an environment the task's machine does not report (#414). */
    readonly ignoredWorkdir?: string;
    /** The machine the environment was resolved on (#414), when the task named one or the environment was resolved through an account there. */
    readonly machineId?: MachineId;
    /** The account the environment was resolved by (#414, `accountKeyOf`), when it was. */
    readonly account?: AccountKey;
    /** An environment the task named that its machine does not report (#414): left aside for the account's environment there. */
    readonly ignoredEnvironment?: EnvironmentId;
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

/** An update was asked of a machine's daemon (#365): by its owner, or by its policy (`by: system:updates`). `to` is a version or `previous`. */
export interface MachineUpdateRequestedData {
    readonly machineId: MachineId;
    readonly from: string;
    readonly to: string;
    readonly mode: 'drain' | 'now';
    readonly by: string;
}

/** The daemon came back on the version it was asked for (#365). */
export interface MachineUpdatedData {
    readonly machineId: MachineId;
    readonly from: string;
    readonly to: string;
}

/** An update did not land (#365): a `failed` phase, a rollback, another version on `hello`, or its deadline. */
export interface MachineUpdateFailedData {
    readonly machineId: MachineId;
    readonly from: string;
    readonly to: string;
    readonly error: string;
}

/**
 * A harness install, update or removal on a machine ended (#370): the daemon's `done` or `failed` phase, or the
 * request's deadline. `from` is the version installed when it was asked, `to` the one asked for (absent for `remove`).
 */
export interface HarnessChangedData {
    readonly machineId: MachineId;
    readonly runtime: RuntimeId;
    readonly op: 'install' | 'update' | 'remove';
    readonly from?: string;
    readonly to?: string;
    readonly outcome: 'done' | 'failed' | 'timeout';
    readonly error?: string;
}

/** The owner set the release channel a machine follows (#365); `null` goes back to the workspace default. */
export interface MachineChannelSetData {
    readonly machineId: MachineId;
    readonly channel: ReleaseChannel | null;
}

/** The owner set when a machine takes updates (#365); `null` goes back to the workspace default. */
export interface MachineUpdatePolicySetData {
    readonly machineId: MachineId;
    readonly policy: UpdatePolicy | null;
}

/**
 * The owner set the folders the web may use on a machine (#355): what was asked (`~` forms included — the machine
 * expands them), what the policy named before, and where the request came from — the page, or the pairing preset.
 */
export interface MachinePolicySetData {
    readonly machineId: MachineId;
    readonly allowedRoots: readonly string[];
    readonly previous: readonly string[];
    readonly source: 'web' | 'pairing';
}

export interface MachineRenamedData {
    readonly machineId: MachineId;
    readonly from: string;
    readonly to: string;
}

/** The owner asked a machine's daemon to restart (#355): `update.request { target: 'restart' }`. */
export interface MachineRestartRequestedData {
    readonly machineId: MachineId;
    readonly mode: 'drain' | 'now';
}

/** The daemon came back after a requested restart (#355). */
export interface MachineRestartedData {
    readonly machineId: MachineId;
}

/** A sign-in relayed from the web ended (#355); never the code that was pasted. */
export interface MachineLoginData {
    readonly machineId: MachineId;
    readonly environmentId: EnvironmentId;
    readonly outcome: 'done' | 'failed' | 'cancelled' | 'timeout';
    readonly error?: string;
}

/** The user re-confirmed through the login provider and made a security-sensitive change with it (#355): recorded once per elevation window, by the first change. */
export interface AuthElevatedData {
    readonly userId: string;
    readonly until: number;
}

export interface PluginToggledData {
    readonly pluginId: string;
}

/** `Registry.grant` widened a plugin's permissions; `scopes` are the ones NEWLY granted. */
export interface PluginGrantedData {
    readonly pluginId: string;
    readonly scopes: readonly PermissionScope[];
}

/** `Registry.revoke` narrowed a plugin's permissions; `scopes` are the ones it HELD and no longer does. */
export type PluginRevokedData = PluginGrantedData;

/** `Registry.setToolPolicy` changed the workspace-default mode of one of a plugin's tools (PLG-03). */
export interface PluginToolPolicyData {
    readonly pluginId: string;
    readonly tool: string;
    readonly mode: ToolMode;
}

/** `Registry.activate` changed which plugin a single-slot kind (memory, learning) runs on; `previous` is the one it replaced. */
export interface PluginActivatedData {
    readonly pluginId: string;
    readonly kind: 'memory' | 'learning';
    readonly previous?: string;
}

/** A secret's plaintext left the Registry (`openSecret`) — every call is an occurrence. */
export interface SecretOpenedData {
    readonly name: string;
    readonly pluginId: string;
}

/**
 * A conduit account changed state in `{ws}:connector-accounts` (#532, EXE-10): connected (created, or reconnected
 * from `needsReauth`), disconnected (deleted), or flagged `needsReauth` (a refresh was refused). Never credentials.
 */
export interface ConnectorAccountData {
    readonly accountId: string;
    readonly connector: string;
    readonly method: string;
    readonly displayName?: string;
    /** `connector.connected` only: the account came back from `needsReauth`. */
    readonly reconnected?: boolean;
}

/** A daemon added a git worktree at an owner's `Machine.fsRequest` (#189, OPS-03). `by` is the owner who asked. */
export interface WorktreeCreatedData {
    readonly machineId: MachineId;
    readonly environmentId: EnvironmentId;
    readonly repo: string;
    readonly branch: string;
    /** Where the worktree was added: absolute, machine-native. */
    readonly path: string;
    readonly base?: string;
    /** The branch existed with no worktree and was checked out again (#618). */
    readonly recreated?: true;
}

/** A project command a machine ran on the owner's behalf (#618): what, where, and how it ended. */
export interface CommandRunData {
    readonly machineId: MachineId;
    readonly environmentId: EnvironmentId;
    readonly cwd: string;
    readonly argv: readonly string[];
    /** The exit code, when the command ran to its end. */
    readonly exitCode?: number;
    /** The refusal or failure (`not-found`, `timeout`, `outside-roots`, …) when it did not. */
    readonly error?: string;
}

/**
 * A daemon answered an owner's `Machine.putEnvironment` (#237, OPS-03): the roots that were asked for and what the
 * machine said — `ok`, or the refusal its local policy gave. `by` is the owner who asked.
 */
export interface EnvironmentPutData {
    readonly machineId: MachineId;
    /** The id the daemon wrote, or the one the request named when it refused. */
    readonly environmentId?: EnvironmentId;
    readonly name: string;
    readonly runtime: RuntimeId;
    /** As requested: absolute, machine-native. */
    readonly cwdRoots: readonly string[];
    readonly outcome: 'ok' | EnvErrorCode;
}

/** A daemon answered an owner's `Machine.removeEnvironment` (#237). */
export interface EnvironmentRemovedData {
    readonly machineId: MachineId;
    readonly environmentId: EnvironmentId;
    readonly outcome: 'ok' | EnvErrorCode;
}

/** `Chat.setProject` moved a chat into a project, or out of one with `null` (#332). `by` is the caller. */
export interface ChatProjectSetData {
    readonly chatId: ChatId;
    readonly projectId: ProjectId | null;
    /** The project's name when it was set. */
    readonly name?: string;
}

/** `chat.machine-set` (#414): the chat runs on this machine from now on, or on none. */
export interface ChatMachineSetData {
    readonly chatId: ChatId;
    readonly machineId: MachineId | null;
    /** The machine's name when it was set. */
    readonly name?: string;
}

/** `Workspace.upsertProject` / `removeProject` changed the workspace's projects (#332). `by` is the owner. */
export interface ProjectChangedData {
    readonly projectId: ProjectId;
    readonly name: string;
    readonly op: 'created' | 'updated' | 'removed';
}

/**
 * `project.chat-released` (#623): a chat left a project, and one of the project's feature plugins tidied up after it
 * on one environment (`onChatReleased`) — what it said it did, or why it could not.
 */
export interface ProjectChatReleasedData {
    readonly chatId: ChatId;
    readonly projectId: ProjectId;
    readonly pluginId: string;
    readonly environmentId: EnvironmentId;
    readonly reason: ProjectFeatureReleaseReason;
    /** What the plugin did, as it said. */
    readonly outcome?: string;
    /** Why it could not: the plugin's error, or the machine being offline. */
    readonly error?: string;
}

/**
 * `session.interrupted` (#366; OPS-05, OPS-06): the machine stopped hosting a session mid-turn and the turn was cut
 * short (`Session.hostEnded`). `host` is the daemon's close code (`restart`, `update`, …), `closed` when it gave none.
 */
export interface SessionInterruptedData {
    readonly sessionId: SessionId;
    readonly taskId?: TaskId;
    readonly turnId: string;
    readonly host: SessionClosedCode | 'closed';
}

/**
 * `session.resumed` (#366): an interrupted task went on — in the same session re-opened or still hosted (`re-host`),
 * or in a fresh one after the daemon refused the re-open (`fresh`; `sessionId` is the new one). `by` is who asked:
 * a person's Resume, or `system:routing` for an agent whose `onInterrupt` is `auto`.
 */
export interface SessionResumedData {
    readonly sessionId: SessionId;
    readonly taskId: TaskId;
    readonly how: 're-host' | 'fresh';
    readonly by: string;
}

/** `task.machine-lost` (#366; OPS-04): the task's machine stayed offline past `MACHINE_LOST_MS`, `since` epoch ms; the task failed recoverable. */
export interface TaskMachineLostData {
    readonly taskId: TaskId;
    readonly machineId: MachineId;
    readonly since: number;
}

/**
 * `pull.merged` / `pull.closed` (#742): a project's pull request merged, or closed without merging — once per PR,
 * by the Pulls actor (`by` is `system:pulls`). `taskId` / `chatId` are what the PR was linked to, when it was.
 */
export interface PullSettledData {
    readonly projectId: ProjectId;
    readonly provider: string;
    readonly repo: string;
    readonly number: number;
    readonly title: string;
    readonly url: string;
    readonly head: string;
    readonly base: string;
    readonly taskId?: TaskId;
    readonly chatId?: ChatId;
}

// slot #750 plan audit data shapes — replace this line

// slot #758 requests audit data shapes — replace this line

/** The per-kind payload. */
export interface AuditDataByKind {
    readonly 'approval.requested': ApprovalRequestedData;
    readonly 'approval.resolved': ApprovalResolvedData;
    readonly 'chat.project-set': ChatProjectSetData;
    readonly 'chat.machine-set': ChatMachineSetData;
    readonly 'delegation.created': DelegationCreatedData;
    readonly 'environment.chosen': EnvironmentChosenData;
    readonly 'environment.put': EnvironmentPutData;
    readonly 'environment.removed': EnvironmentRemovedData;
    readonly 'task.transition': TaskTransitionData;
    readonly 'config.versioned': ConfigVersionedData;
    readonly 'connector.connected': ConnectorAccountData;
    readonly 'connector.disconnected': ConnectorAccountData;
    readonly 'connector.needs-reauth': ConnectorAccountData;
    readonly 'proposal.reviewed': ProposalReviewedData;
    readonly 'machine.paired': MachinePairedData;
    readonly 'machine.revoked': MachineRevokedData;
    readonly 'machine.update-requested': MachineUpdateRequestedData;
    readonly 'machine.updated': MachineUpdatedData;
    readonly 'machine.update-failed': MachineUpdateFailedData;
    readonly 'machine.channel-set': MachineChannelSetData;
    readonly 'machine.update-policy-set': MachineUpdatePolicySetData;
    readonly 'machine.policy-set': MachinePolicySetData;
    readonly 'machine.renamed': MachineRenamedData;
    readonly 'machine.restart-requested': MachineRestartRequestedData;
    readonly 'machine.restarted': MachineRestartedData;
    readonly 'machine.login': MachineLoginData;
    readonly 'auth.elevated': AuthElevatedData;
    readonly 'harness.changed': HarnessChangedData;
    readonly 'plugin.enabled': PluginToggledData;
    readonly 'plugin.disabled': PluginToggledData;
    readonly 'plugin.granted': PluginGrantedData;
    readonly 'plugin.revoked': PluginRevokedData;
    readonly 'plugin.tool-policy': PluginToolPolicyData;
    readonly 'plugin.activated': PluginActivatedData;
    readonly 'project.changed': ProjectChangedData;
    readonly 'project.chat-released': ProjectChatReleasedData;
    readonly 'secret.opened': SecretOpenedData;
    readonly 'session.interrupted': SessionInterruptedData;
    readonly 'session.resumed': SessionResumedData;
    readonly 'task.machine-lost': TaskMachineLostData;
    readonly 'workdir.worktree-created': WorktreeCreatedData;
    readonly 'workdir.command-run': CommandRunData;

    readonly 'pull.merged': PullSettledData;
    readonly 'pull.closed': PullSettledData;

    // slot #750 plan audit data by kind — replace this line

    // slot #758 requests audit data by kind — replace this line
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
