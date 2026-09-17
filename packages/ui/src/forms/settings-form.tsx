/**
 * `SettingsForm` — workspace settings (time zone, notification preferences,
 * default environment) bound to a `WorkspaceSettings` through `model=`,
 * posting pre-hydration with the names in `SETTINGS_FIELDS`.
 */

import { component, type Define } from '@sigx/runtime-core';
import { batch, computed, signal } from '@sigx/reactivity';
import { Button, Combobox, Field } from '@sigx/zero';
import { NOTIFICATION_KINDS, type NotificationKind, type WorkspaceSettings } from '@agentic/core';
import { SETTINGS_FIELDS as F, defaultWorkspaceSettings, fromSettingsDraft, supportedTimeZones, toSettingsDraft, validateSettingsDraft, type SettingsDraft, type SettingsErrors } from './settings-model.js';
import { SelectField, SwitchField, type FieldOption } from './fields.js';

export interface SettingsFormApi {
    reset(): void;
    submit(): boolean;
    errors(): SettingsErrors;
    readonly draft: SettingsDraft;
}

export type SettingsFormProps = Define.Model<WorkspaceSettings> &
    Define.Prop<'environments', readonly FieldOption[]> &
    /** The zones offered; defaults to what `Intl` knows here. */
    Define.Prop<'timeZones', readonly string[]> &
    Define.Prop<'action', string> &
    Define.Prop<'method', 'post' | 'get'> &
    Define.Prop<'submitLabel', string> &
    Define.Prop<'disabled', boolean> &
    Define.Event<'submit', WorkspaceSettings> &
    Define.Event<'invalid', SettingsErrors> &
    Define.Expose<SettingsFormApi>;

const KIND_LABELS: Record<NotificationKind, string> = {
    reminder: 'Reminders',
    'task-done': 'Completed tasks',
    'task-failed': 'Failed tasks',
    approval: 'Approval requests',
    input: 'Requests for input'
};

/** How many zones the picker lists at once; typing narrows. */
const ZONE_WINDOW = 50;

export const SettingsForm = component<SettingsFormProps>(
    ({ props, emit, expose }) => {
        const source = (): WorkspaceSettings => props.model?.value ?? defaultWorkspaceSettings();
        const draft = signal<SettingsDraft>(toSettingsDraft(source()));
        const ui = signal({ attempted: false, zoneQuery: '' });
        let intlZones: readonly string[] | undefined;
        const zones = (): readonly string[] => props.timeZones ?? (intlZones ??= supportedTimeZones());
        const errors = computed(() => validateSettingsDraft(draft, zones()));
        const shown = (): SettingsErrors => (ui.attempted ? errors.value : {});

        /** The zones matching the query, always including the chosen one; with no known zones the query itself is offered. */
        const zoneCandidates = (): readonly string[] => {
            const known = zones();
            const q = ui.zoneQuery.trim();
            if (!known.length) return q ? [q] : draft.timeZone ? [draft.timeZone] : [];
            const lower = q.toLowerCase();
            const out: string[] = [];
            for (const z of known) {
                if (out.length >= ZONE_WINDOW) break;
                if (!lower || z.toLowerCase().includes(lower)) out.push(z);
            }
            if (draft.timeZone && !out.includes(draft.timeZone)) out.push(draft.timeZone);
            return out;
        };

        const reset = () => {
            batch(() => {
                Object.assign(draft, toSettingsDraft(source()));
                ui.attempted = false;
                ui.zoneQuery = '';
            });
        };
        const submit = (): boolean => {
            ui.attempted = true;
            const e = errors.value;
            if (Object.keys(e).length) {
                emit('invalid', e);
                return false;
            }
            const settings = fromSettingsDraft(draft);
            if (props.model) props.model.value = settings;
            emit('submit', settings);
            return true;
        };
        expose({ reset, submit, errors: () => errors.value, draft });

        const onSubmit = (e: Event) => {
            e.preventDefault();
            submit();
        };

        return () => {
            const err = shown();
            const candidates = zoneCandidates();
            return (
                <form data-scope="ai-form" data-part="root" data-form="settings" action={props.action} method={props.method ?? 'post'} onSubmit={onSubmit}>
                    <fieldset data-scope="ai-form" data-part="section" disabled={props.disabled}>
                        <legend data-scope="ai-form" data-part="section-title">Time</legend>
                        <Field.Root invalid={!!err.timeZone} required>
                            <Field.Label>Time zone</Field.Label>
                            <Combobox.Root model={() => draft.timeZone} model:inputValue={() => ui.zoneQuery} name={F.timeZone} required invalid={!!err.timeZone}>
                                <Combobox.Control>
                                    <Combobox.Input placeholder="Europe/Stockholm" />
                                    <Combobox.Trigger />
                                </Combobox.Control>
                                <Combobox.Popup>
                                    {candidates.map((z) => (
                                        <Combobox.Item value={z} key={z}>
                                            {z}
                                        </Combobox.Item>
                                    ))}
                                    {candidates.length === 0 ? <Combobox.Empty>No matching zone</Combobox.Empty> : null}
                                </Combobox.Popup>
                            </Combobox.Root>
                            <Field.Description>Schedules and reminders resolve against this IANA zone.</Field.Description>
                            {err.timeZone ? <Field.Error>{err.timeZone}</Field.Error> : null}
                        </Field.Root>
                    </fieldset>

                    <fieldset data-scope="ai-form" data-part="section" disabled={props.disabled}>
                        <legend data-scope="ai-form" data-part="section-title">Notifications</legend>
                        {NOTIFICATION_KINDS.map((k) => (
                            <SwitchField key={k} model={() => draft.kinds[k]} name={F.notify(k)} label={KIND_LABELS[k]} />
                        ))}
                        <SwitchField model={() => draft.push} name={F.push} label="Also send push notifications" description="Delivered to every device that subscribed." />
                    </fieldset>

                    <fieldset data-scope="ai-form" data-part="section" disabled={props.disabled}>
                        <legend data-scope="ai-form" data-part="section-title">Execution</legend>
                        <SelectField model={() => draft.defaultEnvironmentId} name={F.environment} label="Default environment" options={props.environments ?? []} placeholder="None" description="Used when neither the agent nor the request names one." />
                    </fieldset>

                    <div data-scope="ai-form" data-part="actions">
                        <Button.Root type="submit" color="primary" disabled={props.disabled}>
                            {props.submitLabel ?? 'Save'}
                        </Button.Root>
                        <Button.Root type="button" variant="ghost" disabled={props.disabled} onClick={reset}>
                            Reset
                        </Button.Root>
                    </div>
                </form>
            );
        };
    },
    { name: 'SettingsForm' }
);
