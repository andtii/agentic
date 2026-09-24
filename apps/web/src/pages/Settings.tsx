import { component, signal, type Define } from 'sigx';
import { DEFAULT_UPDATE_SETTINGS, type UpdateSettings } from '@agentic/core';
import { virtualListbox } from '@sigx/zero/virtual-listbox';
import { Button, ConfirmDialog, Icon, Label, SelectField, StatusPill, Switch, TextField } from '@agentic/ui';
import { opsSettings, type NotificationRow } from '../mock/ops';
import { OpsPage } from './ops/OpsPage';
import { defineTopbar } from '../components/topbar';
import { dataMode } from '../data-mode';
import { LiveSettings } from './ops/LiveSettings';
import { UpdateDefaults } from './machines/UpdateDefaults';

export type SettingsViewProps =
    & Define.Prop<'timeZone', string, true>
    & Define.Prop<'timeZones', readonly string[], true>
    & Define.Prop<'defaultEnvironment', string, true>
    & Define.Prop<'environmentOptions', readonly { value: string; label: string }[], true>
    /** Web Push may slip (architecture §12): when it is unavailable the push column is hidden, not disabled. */
    & Define.Prop<'pushAvailable', boolean, true>
    & Define.Prop<'notifications', readonly NotificationRow[], true>
    & Define.Prop<'apiKeys', readonly { provider: string; masked: string; status: string; label: string }[], true>
    & Define.Prop<'budgets', { monthly: string; perTask: string }, true>
    & Define.Prop<'retention', { sessionLogs: string; artifacts: string }, true>;

/** One two-column form section: a 240 px title-and-hint column, then the controls. */
const Section = component<Define.Prop<'title', string, true> & Define.Prop<'hint', string, true> & Define.Slot<'default'>>(({ props, slots }) => () => (
    <section data-settings-section aria-label={props.title}>
        <div data-settings-lead>
            <h2 data-settings-title>{props.title}</h2>
            <p data-settings-hint>{props.hint}</p>
        </div>
        <div data-settings-controls>{slots.default?.()}</div>
    </section>
));

/**
 * `/settings` — time, the notifications matrix (event × inbox, push), API
 * keys (masked, status pill, Replace), budgets, retention, export and
 * delete. Persistence lands with the Workspace and Registry wiring; the
 * page edits a draft.
 */
defineTopbar('settings', () => ({ actions: () => <Button intent="primary" type="submit" form="settings-form">Save</Button> }));

export const SettingsView = component<SettingsViewProps>(({ props }) => {
    const draft = signal({
        timeZone: props.timeZone,
        environment: props.defaultEnvironment,
        monthly: props.budgets.monthly,
        perTask: props.budgets.perTask,
        sessionLogs: props.retention.sessionLogs,
        artifacts: props.retention.artifacts,
        matrix: Object.fromEntries(props.notifications.flatMap(row => [[`${row.kind}:inbox`, row.inbox], [`${row.kind}:push`, row.push]])) as Record<string, boolean>,
        deleting: false,
        updates: DEFAULT_UPDATE_SETTINGS as UpdateSettings,
        updatesSaved: false
    });
    return () => (
        <OpsPage page="settings" title="Settings" maxWidth="860px">
            <form id="settings-form" data-settings-form onSubmit={(e: Event) => e.preventDefault()}>
                <Section title="Time" hint="Used by every schedule and reminder.">
                    <div data-settings-pair>
                        <SelectField name="time-zone" label="Time zone" model={() => draft.timeZone} options={props.timeZones.map(z => ({ value: z, label: z }))} virtual={virtualListbox} />
                        <SelectField name="default-environment" label="Default environment" model={() => draft.environment} options={props.environmentOptions} />
                    </div>
                </Section>

                <Section title="Notifications" hint="Push needs this browser's permission on each device.">
                    <table data-notify-matrix>
                        <thead>
                            <tr>
                                <th scope="col"><span data-visually-hidden="">Event</span></th>
                                <Label as="th">Inbox</Label>
                                {props.pushAvailable ? <Label as="th">Push</Label> : null}
                            </tr>
                        </thead>
                        <tbody>
                            {props.notifications.map(row => (
                                <tr data-notify-row={row.kind}>
                                    <th scope="row">{row.label}</th>
                                    <td><Switch label={`${row.label} to inbox`} hideLabel model={() => draft.matrix[`${row.kind}:inbox`]} onCheckedChange={(v: boolean) => { draft.matrix = { ...draft.matrix, [`${row.kind}:inbox`]: v }; }} /></td>
                                    {props.pushAvailable
                                        ? <td><Switch label={`${row.label} by push`} hideLabel model={() => draft.matrix[`${row.kind}:push`]} onCheckedChange={(v: boolean) => { draft.matrix = { ...draft.matrix, [`${row.kind}:push`]: v }; }} /></td>
                                        : null}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </Section>

                <Section title="API keys" hint="Your own keys, encrypted at rest. Runtime logins never leave their machine.">
                    <ul data-api-keys>
                        {props.apiKeys.map(key => (
                            <li data-api-key>
                                <Icon name="key" size={15} />
                                <span data-api-provider>{key.provider}</span>
                                <span data-api-masked>{key.masked}</span>
                                <StatusPill status={key.status} label={key.label} />
                                <Button intent="default">Replace</Button>
                            </li>
                        ))}
                    </ul>
                </Section>

                <Section title="Machine updates" hint="Which releases machines follow and when they take them, unless a machine's own page says otherwise. A machine never updates in the middle of a turn unless someone chooses Update now.">
                    <UpdateDefaults value={draft.updates} timeZone={draft.timeZone} status={draft.updatesSaved ? 'Saved.' : ''} onSave={(next: UpdateSettings) => { draft.updates = next; draft.updatesSaved = true; }} />
                </Section>

                <Section title="Budgets" hint="Execution and delegation stop at these limits.">
                    <div data-settings-pair>
                        <TextField name="budget-monthly" label="Monthly spend limit" model={() => draft.monthly} />
                        <TextField name="budget-per-task" label="Default per-task limit" model={() => draft.perTask} />
                    </div>
                </Section>

                <Section title="Retention" hint="Copies already handed to a runtime are outside platform control.">
                    <div data-settings-pair>
                        <TextField name="retention-logs" label="Session logs" model={() => draft.sessionLogs} />
                        <TextField name="retention-artifacts" label="Artifacts" model={() => draft.artifacts} />
                    </div>
                </Section>

                <Section title="Your data" hint="Export streams everything as NDJSON. Delete cascades to every agent, chat and memory.">
                    <div data-settings-actions>
                        <Button intent="default" icon="download">Export workspace</Button>
                        <ConfirmDialog
                            model={() => draft.deleting}
                            title="Delete this workspace?"
                            description="Every agent, chat, task, memory, schedule and machine pairing is deleted. Export first if you want a copy."
                            confirmLabel="Delete everything"
                            cancelLabel="Keep the workspace"
                            onCancel={() => { draft.deleting = false; }}
                            onConfirm={() => { draft.deleting = false; }}
                        />
                        <Button intent="danger" icon="trash" onClick={() => { draft.deleting = true; }}>Delete workspace</Button>
                    </div>
                </Section>
            </form>
        </OpsPage>
    );
});

/** `/settings`: the Workspace's settings on the platform (`LiveSettings`, #145), or the mock draft. */
export const Settings = component(() => () => (dataMode() === 'live' ? <LiveSettings /> : (
    <SettingsView
        timeZone={opsSettings.timeZone}
        timeZones={opsSettings.timeZones}
        defaultEnvironment={opsSettings.defaultEnvironment}
        environmentOptions={opsSettings.environmentOptions}
        pushAvailable={opsSettings.pushAvailable}
        notifications={opsSettings.notifications}
        apiKeys={opsSettings.apiKeys}
        budgets={opsSettings.budgets}
        retention={opsSettings.retention}
    />
)));
