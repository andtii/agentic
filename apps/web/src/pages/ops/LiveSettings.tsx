/**
 * `/settings` on the platform (#145): `Workspace.get()` live for the
 * settings and the OPS-10 task records, the same sections the mock page
 * draws over a draft; Save is `Workspace.updateSettings(patch)` (time zone
 * for every schedule, AST-07; inbox / push preferences, AST-06; the default
 * environment; retention windows in days, `docs/retention.md`). "API keys"
 * lists every secret a plugin declares — set or not, never a value — each
 * linking to the plugin's page, where it is set (#234); a stored name no
 * plugin declares is listed too. "Export workspace" is `Workspace.exportAll`
 * (its record says what landed and where); "Delete workspace" is
 * `Workspace.deleteAll` behind a dialog that needs the workspace's name
 * typed back. "Machine updates" (#367) sets the channel and policy machines
 * follow by default — `updateSettings({ updates })`, saved on its own.
 */
import { component, effect, onUnmounted, signal, useHead, type Define, type JSXElement } from 'sigx';
import { Link } from '@sigx/router';
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
import { DEFAULT_UPDATE_SETTINGS, type UpdateSettings } from '@agentic/core';
import type { RegistryOverview } from '@agentic/platform';
import { Button, ConfirmDialog, EmptyState, Icon, Label, SelectField, StatusPill, Switch, TextField } from '@agentic/ui';
import { useActorDefs, useViewer } from '../../actors/defs';
import { registryKeyOf, workspaceKeyOf } from '../../actors/keys';
import { formatAge } from '../../mock/workspace';
import { useEnvironmentDirectory } from './environments';
import { pluginHref } from '../plugins/model';
import { useWorkspaceReadiness } from '../plugins/readiness';
import { opStatus, settingsPatch, timeZoneOptions, toDraft, validateDraft, type SettingsDraft } from './live';
import { OpsPage } from './OpsPage';
import { PushDevices } from '../../push/PushDevices';
import { UpdateDefaults } from '../machines/UpdateDefaults';

/** The one form id the topbar's Save submits. */
export const SETTINGS_FORM = 'settings-form';

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

export const LiveSettings = component(() => {
    useHead({ title: 'Settings' });
    const defs = useActorDefs();
    const viewer = useViewer()();
    const environments = useEnvironmentDirectory(defs, viewer);
    const wsKey = (): string | null => (viewer.workspaceId ? workspaceKeyOf(viewer.workspaceId) : null);
    const workspace = useActorState(defs.Workspace, () => { const k = wsKey(); return k && ([k, 'get'] as const); }, { live: true });
    const secrets = useActorState(defs.Registry, () => (viewer.workspaceId ? ([registryKeyOf(viewer.workspaceId), 'secrets'] as const) : null), { live: true });
    const plugins = useWorkspaceReadiness(defs, viewer);

    const draft = signal<SettingsDraft & { loaded: boolean }>({ loaded: false, timeZone: 'UTC', environmentId: '', inbox: true, push: false, sessionLogDays: '90', artifactDays: '30' });
    const st = signal({ saving: false, saved: false, error: '', deleting: false, typed: '', exporting: false, deleteAsked: false });
    const upd = signal({ busy: false, status: '', failed: false });
    let seenSettings: unknown;
    /** The draft as it was last synced from the actor: edits are what differs from it. */
    let synced: SettingsDraft | null = null;
    const snapshot = (): SettingsDraft => ({ timeZone: draft.timeZone, environmentId: draft.environmentId, inbox: draft.inbox, push: draft.push, sessionLogDays: draft.sessionLogDays, artifactDays: draft.artifactDays });
    const sameDraft = (a: SettingsDraft, b: SettingsDraft): boolean =>
        a.timeZone === b.timeZone && a.environmentId === b.environmentId && a.inbox === b.inbox && a.push === b.push && a.sessionLogDays === b.sessionLogDays && a.artifactDays === b.artifactDays;
    // The draft follows the actor while the form is clean; edits in progress survive another tab's write.
    // A save's own write matches the draft, so it syncs and the form reads clean again.
    const stopSync = effect(() => {
        const settings = workspace.value?.settings;
        if (!settings || settings === seenSettings) return;
        seenSettings = settings;
        const incoming = toDraft(settings);
        const dirty = synced !== null && !sameDraft(draft, synced);
        if (dirty && !sameDraft(draft, incoming)) return;
        synced = incoming;
        Object.assign(draft, incoming, { loaded: true });
    });
    onUnmounted(stopSync);

    const fail = (e: unknown): void => { st.error = e instanceof Error ? e.message : String(e); };
    const zones = (): readonly string[] => timeZoneOptions(draft.timeZone || workspace.value?.settings.timeZone || 'UTC');

    const save = async (): Promise<void> => {
        const k = wsKey();
        if (!k || st.saving) return;
        const patch = settingsPatch(draft, zones(), (id) => environments.lookup(id)?.descriptor.runtime);
        if (!patch) return;
        st.saving = true;
        st.error = '';
        try {
            await actor(defs.Workspace, k).updateSettings(patch);
            // Saved: the form is clean against what was written, whatever the next read folds in.
            synced = snapshot();
            st.saved = true;
        } catch (e) {
            fail(e);
        } finally {
            st.saving = false;
        }
    };

    /** The machine update defaults, saved apart from the form: the workspace's `settings.updates`. */
    const saveUpdates = async (updates: UpdateSettings): Promise<void> => {
        const k = wsKey();
        if (!k || upd.busy) return;
        upd.busy = true;
        upd.status = '';
        upd.failed = false;
        try {
            await actor(defs.Workspace, k).updateSettings({ updates });
            upd.status = 'Saved.';
        } catch (e) {
            upd.failed = true;
            upd.status = e instanceof Error ? e.message : String(e);
        } finally {
            upd.busy = false;
        }
    };

    const exportAll = async (): Promise<void> => {
        const k = wsKey();
        if (!k || st.exporting) return;
        st.exporting = true;
        st.error = '';
        try {
            await actor(defs.Workspace, k).exportAll();
        } catch (e) {
            fail(e);
        } finally {
            st.exporting = false;
        }
    };

    const deleteAll = async (): Promise<void> => {
        const k = wsKey();
        const name = viewer.workspaceId;
        st.deleteAsked = true;
        if (!k || !name || st.typed.trim() !== name) return;
        st.deleting = false;
        st.error = '';
        try {
            await actor(defs.Workspace, k).deleteAll();
        } catch (e) {
            fail(e);
        }
    };

    return (): JSXElement => {
        const ws = workspace.value;
        const name = viewer.workspaceId;
        if (!ws || !name) {
            const signedOut = !viewer.pending && !name;
            return (
                <OpsPage page="settings" title="Settings" maxWidth="860px">
                    {signedOut
                        ? <EmptyState variant="generic" title="Sign in to edit your settings" caption="Settings belong to your workspace." />
                        : <p data-panel-note aria-busy="true">Loading settings…</p>}
                </OpsPage>
            );
        }
        const errors = validateDraft(draft, zones());
        const exportOp = opStatus(ws.ops?.export, 'export');
        const deleteOp = opStatus(ws.ops?.delete, 'delete');
        const mismatch = st.deleteAsked && st.typed.trim() !== name;
        return (
            <OpsPage page="settings" title="Settings" maxWidth="860px">
                <form id={SETTINGS_FORM} data-settings-form onSubmit={(e: Event) => { e.preventDefault(); void save(); }}>
                    <Section title="Time" hint="Used by every schedule and reminder.">
                        <div data-settings-pair>
                            <SelectField name="time-zone" label="Time zone" model={() => draft.timeZone} options={zones().map((z) => ({ value: z, label: z }))} error={errors.timeZone} />
                            <SelectField
                                name="default-environment"
                                label="Default environment"
                                model={() => draft.environmentId}
                                options={[{ value: '', label: 'platform / anthropic-api / byo-key' }, ...environments.all().map((e) => ({ value: e.id, label: e.label }))]}
                                description={environments.loading ? 'Reading your machines…' : undefined}
                            />
                        </div>
                    </Section>

                    <Section title="Notifications" hint="Reminders, completed and failed work, approvals and input requests. Push needs this browser's permission on each device.">
                        <table data-notify-matrix>
                            <thead>
                                <tr>
                                    <th scope="col"><span data-visually-hidden="">Event</span></th>
                                    <Label as="th">Inbox</Label>
                                    <Label as="th">Push</Label>
                                </tr>
                            </thead>
                            <tbody>
                                <tr data-notify-row="all">
                                    <th scope="row">Every notification</th>
                                    <td><Switch label="Every notification to inbox" hideLabel model={() => draft.inbox} /></td>
                                    <td><Switch label="Every notification by push" hideLabel model={() => draft.push} /></td>
                                </tr>
                            </tbody>
                        </table>
                        <PushDevices />
                    </Section>

                    <Section title="API keys" hint="Keys are set on the page of the plugin that uses them, sealed under the workspace key; only their names are ever shown. Runtime logins never leave their machine.">
                        {apiKeys(plugins.overview(), secrets.value)}
                    </Section>

                    <Section title="Machine updates" hint="Which releases machines follow and when they take them, unless a machine's own page says otherwise. A machine never updates in the middle of a turn unless someone chooses Update now.">
                        <UpdateDefaults value={ws.settings.updates ?? DEFAULT_UPDATE_SETTINGS} timeZone={ws.settings.timeZone} busy={upd.busy} status={upd.status} failed={upd.failed} onSave={(next: UpdateSettings) => { void saveUpdates(next); }} />
                    </Section>

                    <Section title="Retention" hint="Days each record is kept (docs/retention.md). Copies already handed to a runtime are outside platform control.">
                        <div data-settings-pair>
                            <TextField name="retention-logs" label="Session logs (days)" model={() => draft.sessionLogDays} error={errors.sessionLogDays} />
                            <TextField name="retention-artifacts" label="Artifacts (days)" model={() => draft.artifactDays} error={errors.artifactDays} />
                        </div>
                    </Section>

                    <p data-settings-status role="status">
                        {st.saving ? 'Saving…' : st.saved && synced !== null && sameDraft(draft, synced) ? 'Saved.' : ''}
                    </p>

                    <Section title="Your data" hint="Export streams everything as NDJSON to the artifacts bucket, secrets by name only. Delete cascades to every agent, chat, task, memory, schedule and machine pairing.">
                        <div data-settings-actions>
                            <Button intent="default" icon="download" loading={st.exporting || exportOp.state === 'running'} onClick={() => { void exportAll(); }}>Export workspace</Button>
                            <Button intent="danger" icon="trash" onClick={() => { st.typed = ''; st.deleteAsked = false; st.deleting = true; }}>Delete workspace</Button>
                        </div>
                        {exportOp.text ? <p data-op-status="export" data-state={exportOp.state} role="status">{exportOp.text}</p> : null}
                        {deleteOp.text ? <p data-op-status="delete" data-state={deleteOp.state} role="status">{deleteOp.text}</p> : null}
                    </Section>
                </form>
                {st.error ? <p data-chat-error role="alert">{st.error}</p> : null}

                <ConfirmDialog
                    model={() => st.deleting}
                    title="Delete this workspace?"
                    description={`Every agent, chat, task, memory, schedule and machine pairing is deleted. Export first if you want a copy. Type ${name} to confirm.`}
                    confirmLabel="Delete everything"
                    cancelLabel="Keep the workspace"
                    onCancel={() => { st.deleting = false; }}
                    onConfirm={() => { void deleteAll(); }}
                >
                    <TextField name="confirm-workspace" label="Workspace name" model={() => st.typed} placeholder={name} error={mismatch ? `Type ${name} exactly to delete it.` : undefined} />
                </ConfirmDialog>
            </OpsPage>
        );
    };
});

interface KeyRow {
    readonly name: string;
    readonly title: string;
    readonly set: boolean;
    readonly updatedAt?: number;
    /** The plugin that declares it; absent for a stored name nobody declares. */
    readonly plugin?: { readonly id: string; readonly name: string };
    readonly required: boolean;
}

/** Every declared secret, set or not, then any stored name no plugin declares (a connector's, an old key). */
export function keyRows(overview: RegistryOverview | undefined, stored: readonly { readonly name: string; readonly updatedAt: number }[] | null | undefined): KeyRow[] {
    const at = new Map((stored ?? []).map((s) => [s.name, s.updatedAt]));
    const set = new Set([...(overview?.secretNames ?? []), ...at.keys()]);
    const rows: KeyRow[] = [];
    const declared = new Set<string>();
    for (const p of overview?.plugins ?? []) {
        for (const s of p.manifest.secrets ?? []) {
            declared.add(s.name);
            const updatedAt = at.get(s.name);
            rows.push({ name: s.name, title: s.title, set: set.has(s.name), plugin: { id: p.manifest.id, name: p.manifest.name }, required: s.required, ...(updatedAt !== undefined ? { updatedAt } : {}) });
        }
    }
    for (const name of [...set].filter((n) => !declared.has(n)).sort()) {
        const updatedAt = at.get(name);
        rows.push({ name, title: name, set: true, required: false, ...(updatedAt !== undefined ? { updatedAt } : {}) });
    }
    return rows;
}

function apiKeys(overview: RegistryOverview | undefined, stored: readonly { readonly name: string; readonly updatedAt: number }[] | null | undefined): JSXElement {
    if (!overview && !stored) return <p data-panel-note>Loading…</p>;
    const rows = keyRows(overview, stored);
    if (!rows.length) return <p data-panel-note>No plugin in this workspace needs a key.</p>;
    return (
        <ul data-api-keys>
            {rows.map((r) => (
                <li data-api-key data-secret={r.name} data-set={r.set ? '' : undefined}>
                    <Icon name="key" size={15} />
                    <span data-api-provider>{r.title}</span>
                    <span data-api-masked>{r.set ? '••••••••' : 'not set'}</span>
                    <StatusPill status={r.set ? 'auth-ok' : r.required ? 'needs-review' : 'not-reported'} label={r.set ? 'STORED' : r.required ? 'NEEDED' : 'NOT SET'} hollow={!r.set && !r.required} />
                    {r.plugin
                        ? <Link to={pluginHref(r.plugin.id)} data-api-plugin>{r.set ? `Manage in ${r.plugin.name}` : `Add in ${r.plugin.name}`}</Link>
                        : <span data-api-updated>{r.updatedAt !== undefined ? formatAge(r.updatedAt, Date.now()) : ''}</span>}
                </li>
            ))}
        </ul>
    );
}

