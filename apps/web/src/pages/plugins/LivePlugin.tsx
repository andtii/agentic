/**
 * `/plugins/:id` on the platform (#233, #640): one plugin out of the
 * Registry's live `overview()`, its dependents out of one `dependentsAll()`,
 * its tools' modes out of a live `toolPolicy(id)`, its connector records out
 * of a live `connectors()`, and every change as a direct owner-only Registry
 * call — `configure`, `setSecret` / `deleteSecret`, `setToolPolicy` (drawn at
 * once, rolled back if refused), `grant` / `revoke`, `activate`, `remove`. Making a memory
 * plugin active asks `previewActivation` first and moves the memories with
 * `activate(…, { migrate: true })` only once the owner confirms (#243). A
 * refusal is shown where it belongs (the form, the one secret, the page) and nothing
 * is written. A secret's value goes to `setSecret` and nowhere else: it is
 * never put in page state, the URL, a log or an error string.
 */
import { component, effect, onUnmounted, signal, useData, useHead, type Define } from 'sigx';
import { Link, useRoute, useRouter } from '@sigx/router';
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
import { runtimeKindOf, type PermissionScope, type ToolMode } from '@agentic/core';
import type { Dependents, SlotKind } from '@agentic/platform';
import { EmptyState } from '@agentic/ui';
import { useActorDefs, useViewer } from '../../actors/defs';
import { registryKeyOf } from '../../actors/keys';
import { useAgentDirectory } from '../chat/directory';
import { OpsPage } from '../ops/OpsPage';
import { isInUse, registryErrorText } from './model';
import { PluginDetail, type SecretWrite, type ToolPolicyWrite } from './PluginDetail';
import { endpointOf, pluginHead, toolRows, transportOf } from './detail-model';
import { useWorkspaceReadiness } from './readiness';
import { usePluginSwitches } from './switches';
import { useMemorySwitch } from './useMemorySwitch';
import { LiveRuntimeMachines } from './RuntimeMachines';
import { GenerateKeys } from '../../push/GenerateKeys';
import { VAPID_SECRET, WEB_PUSH_PLUGIN } from '../../push/model';
import { LiveConduitConnect } from './ConduitConnect';
import { LiveConnectorTrigger } from './ConnectorTrigger';
import { hasTrigger } from './connector-trigger';
import { isConduitConnector, managedSecretsOf } from './conduit';

export type LivePluginProps = Define.Prop<'id', string, true>;

export const LivePlugin = component<LivePluginProps>(({ props }) => {
    useHead({ title: 'Plugin' });
    const defs = useActorDefs();
    const viewer = useViewer()();
    const router = useRouter();
    const route = useRoute();
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
    // The tools' effective modes (PLG-03) and the connector records (transport, endpoint, reported tools), both live.
    const policy = useActorState(defs.Registry, () => { const k = key(); return !!k && !!plugin() && ([k, 'toolPolicy', props.id] as const); }, { live: true });
    const connectors = useActorState(defs.Registry, () => { const k = key(); return !!k && ([k, 'connectors'] as const); }, { live: true });
    // The topbar reads the crumb from here.
    const stopHead = effect(() => {
        const p = plugin();
        pluginHead.value = p ? { id: props.id, name: p.manifest.name, kind: p.manifest.kind } : null;
    });
    onUnmounted(() => { stopHead(); pluginHead.value = null; });
    const switches = usePluginSwitches({
        defs,
        key,
        plugins: () => ready.overview()?.plugins ?? [],
        readiness: () => ready.byId(),
        agentName: (id) => agents.lookup(id).name,
        onChanged: () => { if (usedBy.hasValue) void usedBy.refresh(); }
    });
    const st = signal<{ saving: boolean; saved: boolean; configError: string; secretBusy: string | null; secretErrors: Record<string, string>; busy: boolean; forceRemove: boolean; error: string; optimistic: Record<string, ToolMode> }>({
        saving: false, saved: false, configError: '', secretBusy: null, secretErrors: {}, busy: false, forceRemove: false, error: '', optimistic: {}
    });

    /**
     * One tool's workspace-default mode (PLG-03): drawn at once, written with `setToolPolicy`, and held until the
     * live policy has it; a refusal rolls the row back to what the Registry says and names why.
     */
    const setToolPolicy = async (w: ToolPolicyWrite): Promise<void> => {
        const k = key();
        if (!k || Object.hasOwn(st.optimistic, w.tool)) return;
        st.optimistic = { ...st.optimistic, [w.tool]: w.mode };
        st.error = '';
        try {
            await actor(defs.Registry, k).setToolPolicy(props.id, w.tool, w.mode);
            await policy.refresh();
        } catch (e) {
            st.error = `${w.tool} stays as it was: ${registryErrorText(e)}`;
        } finally {
            const { [w.tool]: _done, ...rest } = st.optimistic;
            void _done;
            st.optimistic = rest;
        }
    };

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
    const nameOf = (id: string): string => ready.overview()?.plugins.find((p) => p.manifest.id === id)?.manifest.name ?? id;
    const memory = useMemorySwitch({
        defs,
        run: act,
        busy: () => st.busy,
        nameOf,
        agentName: (id) => agents.lookup(id).name,
        onActivated: async () => { if (usedBy.hasValue) await usedBy.refresh(); }
    });
    const activate = (): Promise<void> => {
        const p = plugin();
        return p ? memory.activate(p.manifest.kind as SlotKind, props.id) : Promise.resolve();
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
        const record = connectors.value?.find((c) => c.pluginId === props.id);
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
                                    managedSecrets={managedSecretsOf(p.manifest)}
                                    transport={transportOf(p.manifest, connectors.value ?? [])}
                                    tools={toolRows(p.manifest, policy.value ?? undefined, st.optimistic, record?.tools)}
                                    endpoint={p.manifest.kind === 'connector' && !isConduitConnector(p.manifest) ? endpointOf(p, record, ready.overview()!.secretNames) : undefined}
                                    // A conduit connector (Gmail, #533): who is signed in, the OAuth client, Connect / Reconnect / Sign out.
                                    account={() => (isConduitConnector(p.manifest) && viewer.workspaceId
                                        ? <LiveConduitConnect plugin={p} workspaceId={viewer.workspaceId} secretNames={ready.overview()!.secretNames} hasKek={ready.overview()!.hasKek} defs={defs} query={route.query} />
                                        : null)}
                                    extra={() => (p.manifest.id === WEB_PUSH_PLUGIN && viewer.workspaceId
                                        ? <GenerateKeys plugin={p} workspaceId={viewer.workspaceId} hasKek={ready.overview()!.hasKek} hasPrivateKey={ready.overview()!.secretNames.includes(VAPID_SECRET)} defs={defs} />
                                        // A trigger this deployment runs (#535): new email wakes an agent.
                                        : isConduitConnector(p.manifest) && viewer.workspaceId && hasTrigger(p.manifest)
                                            ? <LiveConnectorTrigger plugin={p} workspaceId={viewer.workspaceId} defs={defs} />
                                            // A harness runtime (#370): the machines that have it or lack it.
                                            : runtimeKindOf(p.manifest) === 'harness' ? <LiveRuntimeMachines runtime={p.manifest.id} name={p.manifest.name} /> : null)}
                                    onConfigure={(config: Record<string, unknown>) => { void configure(config); }}
                                    onSaveSecret={(w: SecretWrite) => { void saveSecret(w); }}
                                    onRemoveSecret={(name: string) => { void removeSecret(name); }}
                                    onToolPolicy={(w: ToolPolicyWrite) => { void setToolPolicy(w); }}
                                    onGrant={(scope: PermissionScope) => { void grant(scope); }}
                                    onRevoke={(scope: PermissionScope) => { void revoke(scope); }}
                                    onActivate={() => { void activate(); }}
                                    onRemove={() => { void remove(); }}
                                />
                            )}
                {switches.left()[props.id] ? <p data-plugin-left role="status">Disabled. New work cannot use it; running work finishes.</p> : null}
                {st.error || switches.error() ? <p data-chat-error role="alert">{st.error || switches.error()}</p> : null}
                {switches.dialog()}
                {memory.dialog()}
            </OpsPage>
        );
    };
});
