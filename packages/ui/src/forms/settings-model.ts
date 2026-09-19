/** `SettingsFormValue` ⇄ the draft a `SettingsForm` edits; the same pair of paths as `agent-model.ts`. */

import type { EnvironmentId, NotificationKind } from '@agentic/core';
import { NOTIFICATION_KINDS } from '@agentic/core';
import { flag, text } from './form-data.js';

export const SETTINGS_FIELDS = {
    timeZone: 'time-zone',
    notify: (kind: NotificationKind) => `notify:${kind}`,
    push: 'push',
    environment: 'default-environment'
} as const;

/**
 * What a `SettingsForm` edits: per-kind notification switches and a default environment. Its own shape —
 * core's `WorkspaceSettings` is the one the Workspace actor stores (#227), which the live Settings page edits directly.
 */
export interface SettingsFormValue {
    /** IANA time zone name (`Europe/Stockholm`). */
    readonly timeZone: string;
    readonly notifications: { readonly kinds: Readonly<Record<NotificationKind, boolean>>; readonly push: boolean };
    readonly defaultEnvironmentId?: EnvironmentId;
}

export interface SettingsDraft {
    timeZone: string;
    kinds: Record<NotificationKind, boolean>;
    push: boolean;
    defaultEnvironmentId: string;
}

export type SettingsErrors = Partial<Record<'timeZone', string>>;

export function defaultWorkspaceSettings(timeZone = 'UTC'): SettingsFormValue {
    return {
        timeZone,
        notifications: { kinds: Object.fromEntries(NOTIFICATION_KINDS.map((k) => [k, true])) as SettingsDraft['kinds'], push: false }
    };
}

export function toSettingsDraft(settings: SettingsFormValue): SettingsDraft {
    return {
        timeZone: settings.timeZone,
        kinds: { ...settings.notifications.kinds },
        push: settings.notifications.push,
        defaultEnvironmentId: settings.defaultEnvironmentId ?? ''
    };
}

export function fromSettingsDraft(draft: SettingsDraft): SettingsFormValue {
    return {
        timeZone: draft.timeZone.trim(),
        notifications: { kinds: { ...draft.kinds }, push: draft.push },
        ...(draft.defaultEnvironmentId ? { defaultEnvironmentId: draft.defaultEnvironmentId as EnvironmentId } : {})
    };
}

export function settingsDraftFromFormData(fd: FormData): SettingsDraft {
    const F = SETTINGS_FIELDS;
    return {
        timeZone: text(fd, F.timeZone),
        kinds: Object.fromEntries(NOTIFICATION_KINDS.map((k) => [k, flag(fd, F.notify(k))])) as SettingsDraft['kinds'],
        push: flag(fd, F.push),
        defaultEnvironmentId: text(fd, F.environment)
    };
}

/** Parse a posted settings form straight to its settings (the server-side path). */
export function parseSettingsFormData(fd: FormData, zones?: readonly string[]): { settings: SettingsFormValue; errors: SettingsErrors } {
    const draft = settingsDraftFromFormData(fd);
    return { settings: fromSettingsDraft(draft), errors: validateSettingsDraft(draft, zones) };
}

/**
 * The IANA zones this runtime knows. `Intl.supportedValuesOf` exists on
 * Workers, browsers and Node 18+; without it the list is empty and the form
 * accepts any non-empty zone.
 */
export function supportedTimeZones(): readonly string[] {
    const intl = Intl as { supportedValuesOf?: (key: 'timeZone') => string[] };
    try {
        return intl.supportedValuesOf ? intl.supportedValuesOf('timeZone') : [];
    } catch {
        return [];
    }
}

export function validateSettingsDraft(draft: SettingsDraft, zones: readonly string[] = supportedTimeZones()): SettingsErrors {
    const tz = draft.timeZone.trim();
    if (!tz) return { timeZone: 'Choose a time zone.' };
    if (zones.length && tz !== 'UTC' && !zones.includes(tz)) return { timeZone: `Unknown time zone "${tz}".` };
    return {};
}
