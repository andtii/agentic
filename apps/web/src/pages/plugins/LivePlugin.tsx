/**
 * `/plugins/:id` on the platform (#233): one plugin out of the Registry's
 * live `overview()`, its dependents out of one `dependentsAll()`, and every
 * change as a direct owner-only Registry call — `configure`, `setSecret` /
 * `deleteSecret`, `grant` / `revoke`, `activate`, `remove`. Making a memory
 * plugin active asks `previewActivation` first and moves the memories with
 * `activate(…, { migrate: true })` only once the owner confirms (#243). A
 * refusal is shown where it belongs (the form, the one secret, the page) and nothing
 * is written. A secret's value goes to `setSecret` and nowhere else: it is
 * never put in page state, the URL, a log or an error string.
 */
import { component, signal, useData, useHead, type Define } from 'sigx';
import { Link, useRouter } from '@sigx/router';
import { actor } from '@sigx/actors';
import type { PermissionScope } from '@agentic/core';
import type { Dependents, MemorySwitchReport, SlotKind } from '@agentic/platform';
import { ConfirmDialog, EmptyState } from '@agentic/ui';
import { useActorDefs, useViewer } from '../../actors/defs';
import { registryKeyOf } from '../../actors/keys';
import { useAgentDirectory } from '../chat/directory';
import { OpsPage } from '../ops/OpsPage';
import { isInUse, memorySwitchText, registryErrorText } from './model';
import { PluginDetail, type SecretWrite } from './PluginDetail';
import { useWorkspaceReadiness } from './readiness';
import { usePluginSwitches } from './switches';
import { GenerateKeys } from '../../push/GenerateKeys';
import { VAPID_SECRET, WEB_PUSH_PLUGIN } from '../../push/model';

export type LivePluginProps = Define.Prop<'id', string, true>;

export const LivePlugin = component<LivePluginProps>(({ props }) => {
    useHead({ title: 'Plugin' });
    const defs = useActorDefs();
    const viewer = useViewer()();
    const router = useRouter();
    const agents = useAgentDirectory(defs, viewer);
    const key = (): string | null => (viewer.workspaceId ? registryKeyOf(viewer.workspaceId) : null);
    const ready = useWorkspaceReadiness(defs, viewer);
    const plugin = () => ready.overview()?.plugins.find((p) => p.manifest.id === props.id);
    const usedBy = useData(
        () => {
            const k = key();
            return k && plugin() ? (['dependents-all', k, props.id] as const) : false;
        },
        async (k): Promise<Dependents | undefined> => (await actor(defs.Registry, (k as readonly string[])[1]!).dependentsAll()).find((d) => d.pluginId === props.id)
    );
    const switches = usePluginSwitches({
        defs,
        key,
        plugins: () => ready.overview()?.plugins ?? [],
        readiness: () => ready.byId(),
        agentName: (id) => agents.lookup(id).name,
        onChanged: () => { if (usedBy.hasValue) void usedBy.refresh(); }
    });
    const st = signal<{ saving: boolean; saved: boolean; configError: string; secretBusy: string | null; secretErrors: Record<string, string>; busy: boolean; forceRemove: boolean; error: string }>({
        saving: false, saved: false, configError: '', secretBusy: null, secretErrors: {}, busy: false, forceRemove: false, error: ''
    });

    const configure = async (config: Record<string, unknown>): Promise<void> => {
        const k = key();
        if (!k || st.saving) return;
        st.saving = true;
        st.saved = false;
        st.configError = '';
        try {
            await actor(defs.Registry, k).configure(props.id, config);
            st.saved = true;
        } catch (e) {
            // `bad-config` names every path; the form shows it above its buttons, and nothing was written.
            st.configError = registryErrorText(e);
        } finally {
            st.saving = false;
        }
    };

    /** One secret write or removal; what it refused lands under that secret's field. */
    const secret = async (name: string, call: (k: string) => Promise<unknown>): Promise<void> => {
        const k = key();
        if (!k || st.secretBusy) return;
        st.secretBusy = name;
        const { [name]: _cleared, ...rest } = st.secretErrors;
        void _cleared;
        st.secretErrors = rest;
        try {
            await call(k);
        } catch (e) {
            st.secretErrors = { ...st.secretErrors, [name]: registryErrorText(e) };
        } finally {
            st.secretBusy = null;
        }
    };
    const saveSecret = (w: SecretWrite): Promise<void> => secret(w.name, (k) => actor(defs.Registry, k).setSecret(w.name, w.value));
    const removeSecret = (name: string): Promise<void> => secret(name, (k) => actor(defs.Registry, k).deleteSecret(name));

    /** A grant, revoke or activate: the live overview carries the result back. */
    const act = async (call: (k: string) => Promise<unknown>): Promise<void> => {
        const k = key();
        if (!k || st.busy) return;
        st.busy = true;
        st.error = '';
        try {
            await call(k);
        } catch (e) {
            st.error = registryErrorText(e);
        } finally {
            st.busy = false;
        }
    };
    const grant = (scope: PermissionScope): Promise<void> => act((k) => actor(defs.Registry, k).grant(props.id, [scope]));
    const revoke = (scope: PermissionScope): Promise<void> => act((k) => actor(defs.Registry, k).revoke(props.id, [scope]));
    /** A memory plugin's dry run, while its confirmation is open (#243). */
    const move = signal<{ preview: MemorySwitchReport | null }>({ preview: null });
    const activate = (): Promise<void> => act(async (k) => {
        const kind = plugin()!.manifest.kind as SlotKind;
        // A memory plugin holds data: show what moving it keeps and drops, and move only on confirm.
        if (kind === 'memory') {
            move.preview = await actor(defs.Registry, k).previewActivation(kind, props.id);
            return;
        }
        await actor(defs.Registry, k).activate(kind, props.id);
        if (usedBy.hasValue) await usedBy.refresh();
    });
    const confirmMove = (): Promise<void> => act(async (k) => {
        try {
            await actor(defs.Registry, k).activate('memory', props.id, { migrate: true });
        } finally {
            move.preview = null;
        }
        if (usedBy.hasValue) await usedBy.refresh();
    });
    const nameOf = (id: string): string => ready.overview()?.plugins.find((p) => p.manifest.id === id)?.manifest.name ?? id;
    const moveDialog = () => {
        const report = move.preview;
        if (!report) return null;
        const text = memorySwitchText(report, nameOf, (id) => agents.lookup(id).name);
        return (
            <ConfirmDialog
                model={() => move.preview !== null}
                title={text.title}
                description={text.description}
                {...(text.scopes.length ? { dependents: text.scopes, dependentsLabel: `Memories by scope · ${text.scopes.length}` } : {})}
                confirmLabel={text.confirmLabel}
                cancelLabel={`Keep ${nameOf(report.from)}`}
                danger={false}
                busy={st.busy}
                onConfirm={() => { void confirmMove(); }}
                onCancel={() => { move.preview = null; }}
            />
        );
    };

    const remove = async (): Promise<void> => {
        const k = key();
        if (!k || st.busy) return;
        st.busy = true;
        st.error = '';
        try {
            await actor(defs.Registry, k).remove(props.id, st.forceRemove ? { force: true } : {});
            await router.push('/plugins');
        } catch (e) {
            // In use: the button now says what forcing it does, and the next click does it.
            if (!st.forceRemove && isInUse(e)) st.forceRemove = true;
            else st.error = registryErrorText(e);
        } finally {
            st.busy = false;
        }
    };

    return () => {
        const p = plugin();
        const signedOut = !viewer.pending && !viewer.workspaceId;
        return (
            <OpsPage page="plugin" title={p?.manifest.name ?? 'Plugin'}>
                {signedOut
                    ? <EmptyState variant="generic" title="Sign in to see your plugins" caption="Plugins are set up per workspace." />
                    : !ready.overview()
                        ? <p data-plugin-none aria-busy="true">Loading…</p>
                        : !p
                            ? <EmptyState variant="generic" title={`No plugin with id ${props.id}`} caption="It may have been removed, or this deployment does not ship it." slots={{ actions: () => <Link to="/plugins">All plugins</Link> }} />
                            : (
                                <PluginDetail
                                    plugin={p}
                                    readiness={ready.of(p)}
                                    dependents={usedBy.value ?? undefined}
                                    secretNames={ready.overview()!.secretNames}
                                    status={{ saving: st.saving, saved: st.saved, configError: st.configError || undefined, secretBusy: st.secretBusy, secretErrors: st.secretErrors, busy: st.busy, forceRemove: st.forceRemove }}
                                    agentOf={agents.lookup}
                                    toggle={() => switches.switchFor(p)}
                                    extra={() => (p.manifest.id === WEB_PUSH_PLUGIN && viewer.workspaceId
                                        ? <GenerateKeys plugin={p} workspaceId={viewer.workspaceId} hasKek={ready.overview()!.hasKek} hasPrivateKey={ready.overview()!.secretNames.includes(VAPID_SECRET)} defs={defs} />
                                        : null)}
                                    onConfigure={(config: Record<string, unknown>) => { void configure(config); }}
                                    onSaveSecret={(w: SecretWrite) => { void saveSecret(w); }}
                                    onRemoveSecret={(name: string) => { void removeSecret(name); }}
                                    onGrant={(scope: PermissionScope) => { void grant(scope); }}
                                    onRevoke={(scope: PermissionScope) => { void revoke(scope); }}
                                    onActivate={() => { void activate(); }}
                                    onRemove={() => { void remove(); }}
                                />
                            )}
                {switches.left()[props.id] ? <p data-plugin-left role="status">Disabled. New work cannot use it; running work finishes.</p> : null}
                {st.error || switches.error() ? <p data-chat-error role="alert">{st.error || switches.error()}</p> : null}
                {switches.dialog()}
                {moveDialog()}
            </OpsPage>
        );
    };
});
