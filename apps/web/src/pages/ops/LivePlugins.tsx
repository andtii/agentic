/**
 * `/plugins` on the platform (#145): the workspace Registry's `list`,
 * `connectors` and `secrets` as live reads (PLG-02/03; secrets by NAME
 * only, PLG-04 — no read returns a value). The switch is
 * `Registry.enable` / `disable`: turning a plugin off first asks the
 * Registry who depends on it (`dependents`) and lists them by name before
 * the confirm; the disable itself always succeeds and answers with the
 * dependents it leaves behind, which the card then states (AC-13 — new use
 * is refused from now on, nothing running is stopped).
 */
import { component, effect, onUnmounted, signal, useData, useHead } from 'sigx';
import { Link } from '@sigx/router';
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
import type { Dependents, PluginView } from '@agentic/platform';
import { AgentTile, ConfirmDialog, EmptyState, Icon, Label, StatusPill, Switch, Tag } from '@agentic/ui';
import { useActorDefs, useViewer } from '../../actors/defs';
import { registryKeyOf } from '../../actors/keys';
import { formatAge } from '../../mock/workspace';
import { useAgentDirectory } from '../chat/directory';
import { connectorWhere, dependentCount, dependentNames, disableLabel } from './live';
import { OpsPage } from './OpsPage';

interface Confirming {
    readonly plugin: PluginView;
    readonly dependents: Dependents;
}

export const LivePlugins = component(() => {
    useHead({ title: 'Plugins' });
    const defs = useActorDefs();
    const viewer = useViewer()();
    const agents = useAgentDirectory(defs, viewer);
    const key = (): string | null => (viewer.workspaceId ? registryKeyOf(viewer.workspaceId) : null);
    const plugins = useActorState(defs.Registry, () => { const k = key(); return k && ([k, 'list'] as const); }, { live: true });
    const connectors = useActorState(defs.Registry, () => { const k = key(); return k && ([k, 'connectors'] as const); }, { live: true });
    const secrets = useActorState(defs.Registry, () => { const k = key(); return k && ([k, 'secrets'] as const); }, { live: true });
    // Who uses each plugin — one fetch per set of installed ids (the Registry reads the Workspace, every agent and schedule for it).
    const usedBy = useData(
        () => {
            const k = key();
            const ids = plugins.value?.map((p) => p.manifest.id);
            return k && ids ? (['dependents', k, ...ids] as const) : false;
        },
        async (k): Promise<Record<string, Dependents>> => {
            const [, registry, ...ids] = k as readonly [string, string, ...string[]];
            const out: Record<string, Dependents> = {};
            await Promise.all(ids.map(async (id) => { out[id] = await actor(defs.Registry, registry).dependents(id); }));
            return out;
        }
    );
    const st = signal<{ busy: string | null; error: string; confirming: Confirming | null; left: Record<string, Dependents> }>({ busy: null, error: '', confirming: null, left: {} });
    // The switches' own state, following the Registry: a switch held while the dialog decides does not flip until the actor says so.
    const enabled = signal<Record<string, boolean>>({});
    const seen: Record<string, boolean> = {};
    const stopSync = effect(() => {
        for (const p of plugins.value ?? []) {
            const id = p.manifest.id;
            if (seen[id] !== p.enabled) {
                seen[id] = p.enabled;
                enabled[id] = p.enabled;
            }
        }
    });
    onUnmounted(stopSync);
    const fail = (e: unknown): void => { st.error = e instanceof Error ? e.message : String(e); };
    const agentName = (id: string): string => agents.lookup(id).name;

    const disable = async (plugin: PluginView): Promise<void> => {
        const k = key();
        if (!k) return;
        st.busy = plugin.manifest.id;
        st.error = '';
        try {
            const { dependents } = await actor(defs.Registry, k).disable(plugin.manifest.id);
            // What still references it, on the card, until the page is left.
            st.left = { ...st.left, [plugin.manifest.id]: dependents };
        } catch (e) {
            fail(e);
        } finally {
            st.busy = null;
        }
    };

    const toggle = async (plugin: PluginView, next: boolean): Promise<void> => {
        const k = key();
        if (!k || st.busy) return;
        st.error = '';
        if (next) {
            st.busy = plugin.manifest.id;
            try {
                await actor(defs.Registry, k).enable(plugin.manifest.id);
                const { [plugin.manifest.id]: _gone, ...rest } = st.left;
                void _gone;
                st.left = rest;
            } catch (e) {
                fail(e);
            } finally {
                st.busy = null;
            }
            return;
        }
        // Off: ask who depends on it first; the dialog decides, the switch holds meanwhile.
        enabled[plugin.manifest.id] = true;
        st.busy = plugin.manifest.id;
        try {
            const dependents = await actor(defs.Registry, k).dependents(plugin.manifest.id);
            st.busy = null;
            if (dependentCount(dependents)) st.confirming = { plugin, dependents };
            else await disable(plugin);
        } catch (e) {
            st.busy = null;
            fail(e);
        }
    };

    const confirmDisable = (): void => {
        const c = st.confirming;
        st.confirming = null;
        if (c) void disable(c.plugin);
    };

    return () => {
        const rows = plugins.value ?? [];
        const signedOut = !viewer.pending && !viewer.workspaceId;
        const confirming = st.confirming;
        return (
            <OpsPage page="plugins" title="Plugins">
                {signedOut
                    ? <EmptyState variant="generic" title="Sign in to see your plugins" caption="Plugins are installed per workspace." />
                    : plugins.value && !rows.length
                        ? <EmptyState variant="generic" title="No plugins installed" caption="The platform runtime, memory and learning work without any. Connectors and other plugins are registered through the MCP surface." />
                        : (
                            <div data-plugin-grid aria-busy={plugins.loading ? 'true' : undefined}>
                                {rows.map((p) => {
                                    const id = p.manifest.id;
                                    const deps = usedBy.value?.[id];
                                    const left = st.left[id];
                                    return (
                                        <article data-plugin-card data-plugin={id} data-enabled={enabled[id] ? '' : undefined} aria-label={p.manifest.name}>
                                            <header data-plugin-head>
                                                <span data-plugin-name>
                                                    <span>{p.manifest.name}</span>
                                                    <span data-plugin-version>{p.manifest.version}</span>
                                                </span>
                                                <Switch label={`Enable ${p.manifest.name}`} hideLabel model={() => enabled[id]} disabled={st.busy === id} onCheckedChange={(v: boolean) => { void toggle(p, v); }} />
                                            </header>
                                            <Tag>{p.manifest.kind}</Tag>
                                            <p data-plugin-description>{p.manifest.description}</p>
                                            <div data-plugin-section>
                                                <Label>Granted</Label>
                                                {p.grantedPermissions.length
                                                    ? <ul data-plugin-granted>{p.grantedPermissions.map((g) => <li><Icon name="check" size={14} /><span>{g}</span></li>)}</ul>
                                                    : <span data-plugin-none>nothing</span>}
                                            </div>
                                            {p.manifest.permissions.some((perm) => !p.grantedPermissions.includes(perm.scope)) ? (
                                                <div data-plugin-section>
                                                    <Label>Declared, not granted</Label>
                                                    <span data-plugin-unsupported>{p.manifest.permissions.filter((perm) => !p.grantedPermissions.includes(perm.scope)).map((perm) => perm.scope).join(', ')}</span>
                                                </div>
                                            ) : null}
                                            {left ? (
                                                <p data-plugin-left role="status">
                                                    {dependentCount(left)
                                                        ? `Disabled. Still referenced by ${dependentNames(left, agentName).join('; ')} — new use is refused, running work finishes.`
                                                        : 'Disabled. Nothing references it.'}
                                                </p>
                                            ) : null}
                                            <footer data-plugin-foot>
                                                {deps && dependentCount(deps)
                                                    ? (
                                                        <span data-plugin-used>
                                                            Used by {deps.agents.map((a) => { const who = agents.lookup(a.id); return <AgentTile name={a.name || who.name} hue={who.hue} size={20} labelled />; })}
                                                            {deps.schedules.length ? <span data-plugin-schedules>{deps.schedules.length} {deps.schedules.length === 1 ? 'schedule' : 'schedules'}</span> : null}
                                                        </span>
                                                    )
                                                    : <span data-plugin-none>{deps ? 'No dependents' : 'Looking up dependents…'}</span>}
                                                <Link to="/plugins" class="ag-link">Configure</Link>
                                            </footer>
                                        </article>
                                    );
                                })}
                            </div>
                        )}

                {viewer.workspaceId ? (
                    <section data-plugin-connectors aria-label="Connectors">
                        <Label>MCP connectors</Label>
                        {connectors.value?.length
                            ? (
                                <ul data-connector-list>
                                    {connectors.value.map((c) => (
                                        <li data-connector={c.id}>
                                            <span data-connector-name>{c.id}</span>
                                            <Tag>{c.transport}</Tag>
                                            <code data-mono data-dim>{connectorWhere(c)}</code>
                                            <StatusPill status={c.status.state === 'ok' ? 'online' : c.status.state === 'error' ? 'error' : 'unknown'} label={c.status.state === 'ok' ? `${c.tools.length} ${c.tools.length === 1 ? 'tool' : 'tools'}` : c.status.state === 'error' ? 'ERROR' : 'UNCHECKED'} />
                                            <span data-connector-plugin>plugin {c.pluginId}</span>
                                            {c.secrets?.length ? <span data-connector-secrets>secrets: {c.secrets.join(', ')}</span> : null}
                                            {c.status.error ? <span data-connector-error>{c.status.error}</span> : null}
                                        </li>
                                    ))}
                                </ul>
                            )
                            : <p data-plugin-none>{connectors.value ? 'No connectors configured.' : 'Loading…'}</p>}
                    </section>
                ) : null}

                {viewer.workspaceId ? (
                    <section data-plugin-secrets aria-label="Secrets">
                        <Label>Secrets</Label>
                        {secrets.value?.length
                            ? (
                                <ul data-secret-list>
                                    {secrets.value.map((s) => (
                                        <li data-secret={s.name}>
                                            <Icon name="key" size={15} />
                                            <span data-secret-name>{s.name}</span>
                                            <span data-secret-masked>••••••••</span>
                                            <span data-secret-updated>updated {formatAge(s.updatedAt, Date.now())}</span>
                                        </li>
                                    ))}
                                </ul>
                            )
                            : <p data-plugin-none>{secrets.value ? 'No secrets stored. Values are sealed under the workspace key and never shown.' : 'Loading…'}</p>}
                    </section>
                ) : null}

                {st.error ? <p data-chat-error role="alert">{st.error}</p> : null}

                {confirming ? (
                    <ConfirmDialog
                        model={() => st.confirming !== null}
                        title={`Disable ${confirming.plugin.manifest.name}?`}
                        description="These stop being able to start new work with it. Nothing is deleted, nothing running is stopped, and nothing is moved to another runtime."
                        dependents={dependentNames(confirming.dependents, agentName)}
                        dependentsLabel={`Depends on it · ${dependentCount(confirming.dependents)}`}
                        confirmLabel={disableLabel(confirming.plugin)}
                        cancelLabel="Keep enabled"
                        onConfirm={confirmDisable}
                        onCancel={() => { st.confirming = null; }}
                    />
                ) : null}
            </OpsPage>
        );
    };
});
