/** Workspace-level settings: time zone, notification preferences, default environment (architecture §4 Workspace; AST-06/07). */

import type { EnvironmentId } from './ids.js';

/** The notification kinds the Inbox delivers (architecture §4 Inbox). */
export type NotificationKind = 'reminder' | 'task-done' | 'task-failed' | 'approval' | 'input';

export const NOTIFICATION_KINDS: readonly NotificationKind[] = ['reminder', 'task-done', 'task-failed', 'approval', 'input'];

/** Which notification kinds the user wants, and whether they also go to push subscriptions. */
export interface NotificationPrefs {
    readonly kinds: Readonly<Record<NotificationKind, boolean>>;
    readonly push: boolean;
}

export interface WorkspaceSettings {
    /** IANA time zone name (`Europe/Stockholm`); schedules resolve against it (AST-07). */
    readonly timeZone: string;
    readonly notifications: NotificationPrefs;
    /** Where a new task runs when neither the agent nor the request names an environment. */
    readonly defaultEnvironmentId?: EnvironmentId;
}
