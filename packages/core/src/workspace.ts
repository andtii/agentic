/** Workspace-level settings: time zone, notification preferences, defaults for new work, retention (architecture §4 Workspace; AST-06/07, AGT-05, OPS-10). */

import type { RuntimeId } from './agent.js';
import type { EnvironmentId } from './ids.js';

/** The notification kinds the Inbox delivers (architecture §4 Inbox). */
export const NOTIFICATION_KINDS = ['reminder', 'task-done', 'task-failed', 'approval', 'input'] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

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
}

/** What a workspace starts with. */
export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
    timeZone: 'UTC',
    notifications: { inbox: true, push: false },
    defaults: { runtime: 'anthropic-api' },
    retention: { sessionLogDays: 90, artifactDays: 30 }
};
