/**
 * One plugin's page, `/plugins/:id` (#233; PLG-02, PLG-03, PLG-04): what it
 * is and whether it can be used, its settings on the kit's `SchemaForm`, one
 * write-only `SecretField` per secret it declares, every permission it asks
 * for with the reason and a grant / revoke, who depends on it, and — for a
 * memory or learning plugin — whether it is the one the workspace runs.
 *
 * It draws and emits; the page owns the Registry (or the mock fixtures). A
 * secret's value passes through `saveSecret` once and is held nowhere here.
 */
import { component, type Define, type JSXElement } from 'sigx';
import { isSingleSlot, type PermissionScope, type PluginReadiness } from '@agentic/core';
import type { Dependents, PluginView } from '@agentic/platform';
import { AgentTile, Button, Icon, Label, ReadinessBadge, SchemaForm, SecretField, Tag, type AgentHue } from '@agentic/ui';
import { dependentCount } from '../ops/live';
import { canActivate, permissionRows, workspaceWideConsequence } from './model';

export interface SecretWrite {
    readonly name: string;
    readonly value: string;
}

/** What the page is doing right now, and what the Registry last refused. */
export interface PluginDetailStatus {
    /** `configure` is in flight. */
    readonly saving?: boolean;
    readonly saved?: boolean;
    /** What `configure` answered when it refused (`bad-config` names every path). */
    readonly configError?: string;
    /** The secret being written or removed. */
    readonly secretBusy?: string | null;
    readonly secretErrors?: Readonly<Record<string, string>>;
    /** A grant, revoke, activate or remove is in flight. */
    readonly busy?: boolean;
    /** Remove was refused because it is in use: the next click forces it. */
    readonly forceRemove?: boolean;
}

export type PluginDetailProps =
    & Define.Prop<'plugin', PluginView, true>
    & Define.Prop<'readiness', PluginReadiness>
    & Define.Prop<'dependents', Dependents>
    /** The names of the secrets the workspace has set (`overview().secretNames`) — never a value. */
    & Define.Prop<'secretNames', readonly string[], true>
    & Define.Prop<'status', PluginDetailStatus>
    & Define.Prop<'agentOf', (id: string) => { readonly name: string; readonly hue?: AgentHue }, true>
    /** The enable switch; the page draws it, because the page holds its state until the Registry answers. */
    & Define.Prop<'toggle', () => JSXElement, true>
    & Define.Event<'configure', Record<string, unknown>>
    & Define.Event<'saveSecret', SecretWrite>
    & Define.Event<'removeSecret', string>
    & Define.Event<'grant', PermissionScope>
    & Define.Event<'revoke', PermissionScope>
    & Define.Event<'activate', void>
    & Define.Event<'remove', void>;

export const PluginDetail = component<PluginDetailProps>(({ props, emit }) => () => {
    const p = props.plugin;
    const m = p.manifest;
    const st = props.status ?? {};
    const deps = props.dependents;
    const slot = isSingleSlot(m.kind);
    return (
        <div data-plugin-detail data-plugin={m.id}>
            <header data-plugin-detail-head>
                <div data-plugin-detail-title>
                    <h2 data-plugin-detail-name>
                        <span>{m.name}</span>
                        <span data-plugin-detail-version>{m.version}</span>
                    </h2>
                    <div data-plugin-detail-tags>
                        <Tag>{m.kind}</Tag>
                        {p.builtin ? <Tag>built in</Tag> : null}
                        {p.active ? <Tag tone="live">active</Tag> : null}
                        {props.readiness ? <ReadinessBadge readiness={props.readiness} detail /> : null}
                    </div>
                </div>
                {props.toggle()}
            </header>
            <p data-plugin-detail-description>{m.description}</p>

            <section data-plugin-panel="config" aria-label="Settings">
                <Label>Settings</Label>
                <SchemaForm
                    schema={m.config}
                    value={p.config}
                    name={`plugin-${m.id}`}
                    saving={st.saving}
                    error={st.configError}
                    onSubmit={(config: Record<string, unknown>) => emit('configure', config)}
                />
                {st.saved ? <p data-plugin-saved role="status">Saved.</p> : null}
            </section>

            {m.secrets?.length ? (
                <section data-plugin-panel="secrets" aria-label="Keys">
                    <Label>Keys</Label>
                    <p data-plugin-hint>Sealed under the workspace key and never shown again. The plugin reads one only while it is enabled and holds the permission for it.</p>
                    {m.secrets.map((s) => (
                        <SecretField
                            name={s.name}
                            label={s.title}
                            description={s.description}
                            required={s.required}
                            isSet={props.secretNames.includes(s.name)}
                            saving={st.secretBusy === s.name}
                            error={st.secretErrors?.[s.name]}
                            onSave={(value: string) => emit('saveSecret', { name: s.name, value })}
                            onRemove={() => emit('removeSecret', s.name)}
                        />
                    ))}
                </section>
            ) : null}

            <section data-plugin-panel="permissions" aria-label="Permissions">
                <Label>Permissions</Label>
                {m.permissions.length ? (
                    <ul data-permission-list>
                        {permissionRows(p).map((row) => (
                            <li data-permission={row.scope} data-granted={row.granted ? '' : undefined}>
                                <span data-permission-scope>
                                    {row.granted ? <Icon name="check" size={14} /> : null}
                                    <code data-mono>{row.scope}</code>
                                </span>
                                <span data-permission-reason>{row.reason}</span>
                                <Button disabled={st.busy} label={`${row.granted ? 'Revoke' : 'Grant'} ${row.scope}`} onClick={() => emit(row.granted ? 'revoke' : 'grant', row.scope)}>
                                    {row.granted ? 'Revoke' : 'Grant'}
                                </Button>
                            </li>
                        ))}
                    </ul>
                ) : <p data-plugin-none>It asks for nothing.</p>}
            </section>

            <section data-plugin-panel="dependents" aria-label="Used by">
                <Label>Used by</Label>
                {!deps
                    ? <p data-plugin-none>Looking up dependents…</p>
                    : deps.workspaceWide
                        ? <p data-plugin-consequence>{workspaceWideConsequence(m.kind)}</p>
                        : dependentCount(deps)
                            ? (
                                <ul data-dependent-list>
                                    {deps.agents.map((a) => { const who = props.agentOf(a.id); return <li data-dependent={a.id}><AgentTile name={a.name || who.name} hue={who.hue} size={20} labelled /><span data-dependent-via>{a.via.join(', ')}</span></li>; })}
                                    {deps.schedules.map((s) => <li data-dependent={s.id}><Icon name="schedules" size={15} /><span>{s.title}</span><span data-dependent-via>schedule via {props.agentOf(s.agentId).name}</span></li>)}
                                </ul>
                            )
                            : <p data-plugin-none>Nothing depends on it.</p>}
            </section>

            {slot || !p.builtin ? (
                <section data-plugin-panel="actions" aria-label="Actions">
                    {slot ? (
                        <div data-plugin-action="activate">
                            <span>{p.active ? `This is the ${m.kind} plugin the workspace runs.` : `The workspace runs another ${m.kind} plugin.`}</span>
                            {canActivate(p) ? <Button intent="primary" loading={st.busy} onClick={() => emit('activate')}>Make active</Button> : null}
                        </div>
                    ) : null}
                    {!p.builtin ? (
                        <div data-plugin-action="remove">
                            <span>{st.forceRemove ? 'Agents or schedules still use it. Removing it anyway leaves them pointing at nothing.' : 'Removes the plugin, its settings and its connectors from the workspace.'}</span>
                            <Button intent="danger" confirm={st.forceRemove} disabled={st.busy} onClick={() => emit('remove')}>{st.forceRemove ? 'Remove anyway' : 'Remove'}</Button>
                        </div>
                    ) : null}
                </section>
            ) : null}
        </div>
    );
}, { name: 'PluginDetail' });
