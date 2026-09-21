/** Workspace-level settings: time zone, notification preferences, defaults for new work, retention (architecture §4 Workspace; AST-06/07, AGT-05, OPS-10). */

import type { RuntimeId } from './agent.js';
import type { ChatId, EnvironmentId, MachineId, MessageId, ScheduleId, SessionId, TaskId } from './ids.js';
import type { ReleaseChannel, UpdatePolicy } from './release.js';

/** The notification kinds the Inbox delivers (architecture §4 Inbox). */
export const NOTIFICATION_KINDS = ['reminder', 'task-done', 'task-failed', 'approval', 'input', 'update-available', 'update-applied', 'update-failed', 'daemon-crash-loop', 'harness-update-available', 'resource-pressure', 'machine-security'] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** What a notification is about; the UI deep-links through it. A daemon's update and crash notices point at its `machine` (#359). */
export type NotificationRef =
    | { readonly kind: 'task'; readonly taskId: TaskId }
    | { readonly kind: 'schedule'; readonly scheduleId: ScheduleId }
    | { readonly kind: 'session'; readonly sessionId: SessionId; readonly requestId?: string }
    | { readonly kind: 'chat'; readonly chatId: ChatId; readonly messageId?: MessageId }
    | { readonly kind: 'machine'; readonly machineId: MachineId };

/** Where the workspace's notifications go: the Inbox, and the user's push subscriptions. */
export interface NotificationPrefs {
    readonly inbox: boolean;
    readonly push: boolean;
}

/** What new work starts from when neither the agent nor the request says otherwise. A model is the runtime's to default, never the workspace's. */
export interface WorkspaceDefaults {
    /** The runtime a new agent is created on. */
    readonly runtime: RuntimeId;
    /** Where a task runs when neither the agent nor the request names an environment (AGT-05). */
    readonly environmentId?: EnvironmentId;
}

/** Retention windows in days (OPS-10, `docs/retention.md`). */
export interface RetentionSettings {
    readonly sessionLogDays: number;
    readonly artifactDays: number;
}

export interface WorkspaceSettings {
    /** IANA time zone name (`Europe/Stockholm`); schedules and digests resolve against it (AST-07). */
    readonly timeZone: string;
    readonly notifications: NotificationPrefs;
    readonly defaults: WorkspaceDefaults;
    readonly retention: RetentionSettings;
    /** How machines take daemon updates (#359; OPS-03); absent means `stable` / `manual`. */
    readonly updates?: UpdateSettings;
}

/** The release channel and update policy a machine follows unless it is given its own. */
export interface UpdateSettings {
    readonly defaultChannel: ReleaseChannel;
    readonly defaultPolicy: UpdatePolicy;
}

/** What `WorkspaceSettings.updates` means when it is absent. */
export const DEFAULT_UPDATE_SETTINGS: UpdateSettings = { defaultChannel: 'stable', defaultPolicy: { kind: 'manual' } };

/** What a workspace starts with. */
export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
    timeZone: 'UTC',
    notifications: { inbox: true, push: false },
    defaults: { runtime: 'anthropic-api' },
    retention: { sessionLogDays: 90, artifactDays: 30 }
};
