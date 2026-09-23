/**
 * A connector trigger's page model (#535; AST-09, PLG-01 `trigger`): pure,
 * over what the Gmail plugin page reads — the workspace's schedules and
 * agents. The trigger IS a Schedule entry (`source: { kind: 'connector' }`),
 * so it also shows on /schedules, and the platform's own entry alarm polls
 * it with no browser open. No hook, no DOM, nothing of `@agentic/platform`
 * at runtime.
 */
import type { AgentId, PluginManifest } from '@agentic/core';
import type { ScheduleSpec, ScheduleView, SchedulePatch } from '@agentic/platform';

/** Poll intervals offered, in minutes. Five is the floor: Gmail's quota and a sensible cost per workspace. */
export const TRIGGER_INTERVALS = [5, 10, 15, 30, 60] as const;
export const DEFAULT_TRIGGER_INTERVAL = 5;
/** What a new trigger filters on: the inbox, as the Gmail app shows it. */
export const DEFAULT_TRIGGER_QUERY = 'in:inbox';
/** `SOURCE_QUERY_MAX` of the Schedule actor. */
export const TRIGGER_QUERY_MAX = 1000;

/** The cron an interval polls on, in UTC (a poll has no wall-clock meaning). */
export function intervalCron(minutes: number): string {
    return minutes >= 60 ? '0 * * * *' : `*/${minutes} * * * *`;
}

/** The interval a trigger's recurrence polls on, or `undefined` for one this page did not write. */
export function intervalOf(view: Pick<ScheduleView, 'recurrence'>): number | undefined {
    const r = view.recurrence;
    if (r.kind !== 'cron') return undefined;
    if (r.cron === '0 * * * *') return 60;
    const m = /^\*\/(\d+) \* \* \* \*$/.exec(r.cron);
    return m ? Number(m[1]) : undefined;
}

/** Whether the connector has a trigger this deployment runs (`trigger:<id>`, #535). */
export function hasTrigger(manifest: PluginManifest): boolean {
    return manifest.capabilities.some((c) => c.startsWith('trigger:'));
}

/** The entry that watches `pluginId`, among the workspace's schedules. */
export function triggerOf(views: readonly (ScheduleView | null)[], pluginId: string): ScheduleView | undefined {
    return views.find((v): v is ScheduleView => !!v && v.source?.kind === 'connector' && v.source.connector === pluginId);
}

/** What the form edits; strings so the fields bind straight to it. */
export interface TriggerDraft {
    agentId: string;
    query: string;
    /** Minutes, as the select's value. */
    interval: string;
    /** What the agent is asked for each email; empty = the platform's default. */
    prompt: string;
}

export type TriggerErrors = Partial<Record<'agentId' | 'query' | 'interval', string>>;

export function draftOf(view: ScheduleView | undefined): TriggerDraft {
    return {
        agentId: view?.agentId ?? '',
        query: view ? (view.source?.query ?? '') : DEFAULT_TRIGGER_QUERY,
        interval: String((view && intervalOf(view)) ?? DEFAULT_TRIGGER_INTERVAL),
        prompt: view?.prompt ?? ''
    };
}

export function validateTrigger(draft: TriggerDraft): TriggerErrors {
    const errors: TriggerErrors = {};
    if (!draft.agentId) errors.agentId = 'Pick the agent each new email wakes.';
    if (draft.query.length > TRIGGER_QUERY_MAX) errors.query = `At most ${TRIGGER_QUERY_MAX} characters.`;
    if (!(TRIGGER_INTERVALS as readonly number[]).includes(Number(draft.interval))) errors.interval = 'Pick an interval.';
    return errors;
}

const titleOf = (name: string, agentName: string): string => `New ${name} email → ${agentName}`;

/** A new entry, on — `null` while the draft does not validate. */
export function triggerSpec(draft: TriggerDraft, pluginId: string, name: string, agentName: string): ScheduleSpec | null {
    if (Object.keys(validateTrigger(draft)).length) return null;
    const query = draft.query.trim();
    const prompt = draft.prompt.trim();
    return {
        kind: 'agent-task',
        title: titleOf(name, agentName),
        recurrence: { kind: 'cron', cron: intervalCron(Number(draft.interval)), tz: 'UTC' },
        agentId: draft.agentId as AgentId,
        source: { kind: 'connector', connector: pluginId, ...(query ? { query } : {}) },
        ...(prompt ? { prompt } : {}),
        offlinePolicy: 'queue',
        enabled: true
    };
}

/** The same draft as a patch of the existing entry; its on/off switch is left alone. */
export function triggerPatch(draft: TriggerDraft, pluginId: string, name: string, agentName: string): SchedulePatch | null {
    const spec = triggerSpec(draft, pluginId, name, agentName);
    if (!spec) return null;
    return { title: spec.title, recurrence: spec.recurrence, agentId: spec.agentId!, source: spec.source!, prompt: spec.prompt ?? '' };
}

export type TriggerState =
    | { readonly state: 'none' }
    | { readonly state: 'on'; readonly interval: number | undefined }
    | { readonly state: 'off' }
    /** A poll turned it off (the account needs reconnecting). */
    | { readonly state: 'paused'; readonly reason: string };

export function triggerState(view: ScheduleView | undefined): TriggerState {
    if (!view) return { state: 'none' };
    if (view.enabled) return { state: 'on', interval: intervalOf(view) };
    return view.paused ? { state: 'paused', reason: view.paused.reason } : { state: 'off' };
}

/** One line under the switch. */
export function triggerText(s: TriggerState, name: string): string {
    switch (s.state) {
        case 'on':
            return `On — checks ${name} every ${s.interval ?? '?'} minutes and starts one task per new email.`;
        case 'paused':
            return `Paused: ${s.reason}`;
        case 'off':
            return 'Off — no polls.';
        default:
            return `Not set up. Save to start checking ${name} for new email.`;
    }
}
