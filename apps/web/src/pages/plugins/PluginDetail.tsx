/**
 * One plugin's page, `/plugins/:id` (#233, #640; PLG-03, PLG-04, PLG-09,
 * OPS-02, AC-13), board `PluginDetail`
 * (`docs/design/plugins/HANDOFF-plugins.md` → "Plugin page"):
 *
 * - the header: a 52 px tile, the name 24 / 600 and version, the kind and
 *   transport tags, the description, the readiness pill and the switch;
 * - Account (`#account`, connectors only): the page's conduit sign-in panel,
 *   or an MCP connector's endpoint and token secret;
 * - Tools (`#tools`): one `ToolPolicyRow` per tool with its workspace-default
 *   allow / ask / deny;
 * - Granted (`#granted`): every granted scope with its reason and Revoke,
 *   then every declared scope nobody granted with Grant. Revoking a `tools:`
 *   scope asks first;
 * - Settings (`#config`) on the kit's `SchemaForm` when there is anything to
 *   set, one write-only `SecretField` per secret (`#secrets`), and the kind's
 *   own panel (`extra`: machines, a trigger, Web Push keys);
 * - the right rail: Used by, then Remove with its consequences and every
 *   dependent by name before the button.
 *
 * It draws and emits; the page owns the Registry (or the mock fixtures). A
 * secret's value passes through `saveSecret` once and is held nowhere here.
 */
import { component, signal, type Define, type JSXElement } from 'sigx';
import { derivedModel } from '@sigx/zero/behaviors';
import { isSingleSlot, type PermissionScope, type PluginReadiness, type ToolMode } from '@agentic/core';
import type { Dependents, PluginView } from '@agentic/platform';
import { AgentTile, Button, ConfirmDialog, Icon, Label, ReadinessBadge, SchemaForm, SecretField, Tag, ToolPolicyRow, monogramOf, type AgentHue } from '@agentic/ui';
import { dependentCount } from '../ops/live';
import { asksBeforeRevoke, dependentLines, hasSettings, removeConsequence, scopeRows, toolsOfScope, type EndpointView, type ToolRow } from './detail-model';
import { canActivate, featuresOf, kindLabel, workspaceWideConsequence } from './model';

export interface SecretWrite {
    readonly name: string;
    readonly value: string;
}

export interface ToolPolicyWrite {
    readonly tool: string;
    readonly mode: ToolMode;
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
    /** The transport tag beside the kind (`conduit`, `mcp`) — connectors only. */
    & Define.Prop<'transport', string>
    /** A conduit connector's Account panel, drawn by the page (it reads the accounts); carries `id="account"`. */
    & Define.Prop<'account', () => JSXElement | null>
    /** An MCP connector's Account: its endpoint and token secret. */
    & Define.Prop<'endpoint', EndpointView>
    /** The Tools panel's rows (`toolRows`); none, no panel. */
    & Define.Prop<'tools', readonly ToolRow[]>
    /** One plugin's own panel, drawn after its keys (machines, a trigger, Web Push's "Generate keys"); most plugins have none. */
    & Define.Prop<'extra', () => JSXElement | null>
    /** Declared secrets the plugin manages itself (a conduit connector's engine secret, #533): no field is offered for them. */
    & Define.Prop<'managedSecrets', readonly string[]>
    & Define.Event<'configure', Record<string, unknown>>
    & Define.Event<'saveSecret', SecretWrite>
    & Define.Event<'removeSecret', string>
    & Define.Event<'toolPolicy', ToolPolicyWrite>
    & Define.Event<'grant', PermissionScope>
    & Define.Event<'revoke', PermissionScope>
    & Define.Event<'activate', void>
    & Define.Event<'remove', void>;

export const PluginDetail = component<PluginDetailProps>(({ props, emit }) => {
    /** The `tools:` scope whose revoke is being confirmed. */
    const confirm = signal<{ scope: PermissionScope | null }>({ scope: null });
    const revoke = (scope: PermissionScope): void => {
        if (asksBeforeRevoke(scope)) confirm.scope = scope;
        else emit('revoke', scope);
    };
    const confirmRevoke = (): void => {
        const scope = confirm.scope;
        confirm.scope = null;
        if (scope) emit('revoke', scope);
    };

    return () => {
        const p = props.plugin;
        const m = p.manifest;
        const st = props.status ?? {};
        const deps = props.dependents;
        const slot = isSingleSlot(m.kind);
        const secrets = (m.secrets ?? []).filter((s) => !(props.managedSecrets ?? []).includes(s.name));
        const tools = props.tools ?? [];
        const scopes = scopeRows(p);
        const agentName = (id: string): string => props.agentOf(id).name;
        const confirming = confirm.scope;
        const lost = confirming ? toolsOfScope(confirming, tools.map((t) => t.name)) : [];
        const endpoint = props.endpoint;
        const account = props.account?.() ?? null;
        return (
            <div data-plugin-detail data-plugin={m.id}>
                <header data-plugin-detail-head>
                    {/* Letters only: `GitHub (MCP)` is GM, not G(. */}
                    <AgentTile name={m.name} monogram={monogramOf(m.name.replace(/[^\p{L}\p{N}\s_-]/gu, ''))} size={52} />
                    <div data-plugin-detail-title>
                        <h2 data-plugin-detail-name>
                            <span>{m.name}</span>
                            <span data-plugin-detail-version>{m.version}</span>
                        </h2>
                        <div data-plugin-detail-tags>
                            <Tag>{kindLabel(m)}</Tag>
                            {props.transport ? <Tag>{props.transport}</Tag> : null}
                            {featuresOf(m).map((f) => <Tag key={f} tone="live">{f}</Tag>)}
                            {p.builtin ? <Tag>built in</Tag> : null}
                            {p.active ? <Tag tone="live">active</Tag> : null}
                            <p data-plugin-detail-description>{m.description}</p>
                        </div>
                    </div>
                    <div data-plugin-detail-status>
                        {props.readiness ? <ReadinessBadge readiness={props.readiness} /> : null}
                        {props.toggle()}
                    </div>
                </header>
                {featuresOf(m).length ? (
                    <p data-plugin-usage-limits>
                        Each account reports how close it is to its plan limits (session, week, per model). See them on Machines, in Usage → Limits, and when choosing where an agent runs.
                    </p>
                ) : null}

                <div data-plugin-detail-grid>
                    <div data-plugin-detail-main>
                        {account}
                        {!account && endpoint ? (
                            <section id="account" data-plugin-panel="account" aria-label={`${m.name} account`}>
                                <Label>Account</Label>
                                <dl data-account-rows>
                                    <div data-account-row="endpoint"><dt>Endpoint</dt><dd><code data-mono>{endpoint.endpoint}</code></dd></div>
                                    <div data-account-row="token">
                                        <dt>Token</dt>
                                        <dd>
                                            {endpoint.token
                                                ? <><code data-mono>secret:{endpoint.token.name}</code><span data-account-meta>{endpoint.token.set ? 'stored' : 'not set — add it under Keys'}</span></>
                                                : <span data-account-meta>none — the server takes no token</span>}
                                        </dd>
                                    </div>
                                </dl>
                            </section>
                        ) : null}

                        {tools.length ? (
                            <section id="tools" data-plugin-panel="tools" aria-label="Tools">
                                <div data-plugin-panel-head>
                                    <Label>Tools · {tools.length}</Label>
                                    <span data-plugin-panel-caption>workspace default; an agent’s own policy can only be stricter</span>
                                </div>
                                <div data-tool-list>
                                    {tools.map((t) => (
                                        <ToolPolicyRow
                                            key={t.name}
                                            name={t.name}
                                            description={t.description}
                                            // Shows the page's mode; a pick only emits — the page's state is what shows next.
                                            model={derivedModel<ToolMode>(() => t.mode, (mode) => { if (mode !== t.mode) emit('toolPolicy', { tool: t.name, mode }); })}
                                            pending={t.pending}
                                        />
                                    ))}
                                </div>
                            </section>
                        ) : null}

                        <section id="granted" data-plugin-panel="permissions" aria-label="Granted">
                            <Label>Granted · {scopes.granted.length}</Label>
                            {scopes.granted.length ? (
                                <ul data-permission-list>
                                    {scopes.granted.map((row) => (
                                        <li key={row.scope} data-permission={row.scope} data-granted="">
                                            <span data-permission-scope><Icon name="check" size={14} /><code data-mono>{row.scope}</code></span>
                                            <span data-permission-reason>{row.reason}</span>
                                            <button type="button" data-permission-action="revoke" disabled={st.busy} aria-label={`Revoke ${row.scope}`} onClick={() => revoke(row.scope)}>Revoke</button>
                                        </li>
                                    ))}
                                </ul>
                            ) : <p data-plugin-none>{m.permissions.length ? 'Nothing granted: it cannot use what it asks for until you grant it.' : 'It asks for nothing.'}</p>}
                            {scopes.declared.length ? (
                                <>
                                    <Label>Declared, not granted · {scopes.declared.length}</Label>
                                    <ul data-permission-list data-permission-declared>
                                        {scopes.declared.map((row) => (
                                            <li key={row.scope} data-permission={row.scope}>
                                                <span data-permission-scope><code data-mono>{row.scope}</code></span>
                                                <span data-permission-reason>{row.reason}</span>
                                                <button type="button" data-permission-action="grant" disabled={st.busy} aria-label={`Grant ${row.scope}`} onClick={() => emit('grant', row.scope)}>Grant</button>
                                            </li>
                                        ))}
                                    </ul>
                                </>
                            ) : null}
                        </section>

                        {hasSettings(m.config) ? (
                            <section id="config" data-plugin-panel="config" aria-label="Settings">
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
                        ) : null}

                        {secrets.length ? (
                            <section id="secrets" data-plugin-panel="secrets" aria-label="Keys">
                                <Label>Keys</Label>
                                <p data-plugin-hint>Sealed under the workspace key and never shown again. The plugin reads one only while it is enabled and holds the permission for it.</p>
                                {secrets.map((s) => (
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

                        {props.extra?.() ?? null}

                        {slot ? (
                            <section data-plugin-panel="actions" aria-label="Active plugin">
                                <div data-plugin-action="activate">
                                    <span>{p.active ? `This is the ${m.kind} plugin the workspace runs.` : `The workspace runs another ${m.kind} plugin.`}</span>
                                    {canActivate(p) ? <Button intent="primary" loading={st.busy} onClick={() => emit('activate')}>Make active</Button> : null}
                                </div>
                            </section>
                        ) : null}
                    </div>

                    <aside data-plugin-detail-rail aria-label="Used by and remove">
                        <section data-plugin-panel="dependents" aria-label="Used by">
                            <Label>Used by</Label>
                            {!deps
                                ? <p data-plugin-none>Looking up dependents…</p>
                                : deps.workspaceWide
                                    ? <p data-plugin-consequence>{workspaceWideConsequence(m.kind)}</p>
                                    : dependentCount(deps)
                                        ? (
                                            <ul data-dependent-list>
                                                {deps.agents.map((a) => {
                                                    const who = props.agentOf(a.id);
                                                    return (
                                                        <li key={a.id} data-dependent={a.id}>
                                                            <AgentTile name={a.name || who.name} hue={who.hue} size={28} />
                                                            <span data-dependent-name>
                                                                <span>{a.name || who.name}</span>
                                                                <span data-dependent-via>{a.via.join(', ')}</span>
                                                            </span>
                                                        </li>
                                                    );
                                                })}
                                                {deps.schedules.map((s) => (
                                                    <li key={s.id} data-dependent={s.id}>
                                                        <span data-dependent-icon><Icon name="schedules" size={15} /></span>
                                                        <span data-dependent-name>
                                                            <span>{s.title}</span>
                                                            <span data-dependent-via>schedule via {agentName(s.agentId)}</span>
                                                        </span>
                                                    </li>
                                                ))}
                                            </ul>
                                        )
                                        : <p data-plugin-none>Nothing depends on it.</p>}
                            {m.kind === 'connector' ? <p data-plugin-hint data-dependents-note>Agents get a connector only when you add it to their tools.</p> : null}
                        </section>

                        {p.builtin ? (
                            <section data-plugin-panel="remove" data-builtin="" aria-label="Remove">
                                <Label>Remove</Label>
                                <p data-plugin-hint>{m.name} ships with this deployment, so it cannot be removed. Turn it off with the switch above: new work stops using it, and nothing running is stopped.</p>
                            </section>
                        ) : (
                            <section data-plugin-panel="remove" data-plugin-action="remove" aria-label="Remove">
                                <Label>Remove</Label>
                                <p data-plugin-consequence>{removeConsequence(p, deps, props.secretNames, agentName)}</p>
                                {dependentLines(deps, agentName).length ? (
                                    <ul data-remove-dependents aria-label="Still uses it">
                                        {dependentLines(deps, agentName).map((line) => <li key={line}>{line}</li>)}
                                    </ul>
                                ) : null}
                                {st.forceRemove ? <p data-plugin-hint role="status">They still use it. Removing it anyway leaves them pointing at nothing.</p> : null}
                                <div>
                                    <Button intent="danger" confirm={st.forceRemove} disabled={st.busy} onClick={() => emit('remove')}>{st.forceRemove ? `Remove ${m.name} anyway` : `Remove ${m.name}`}</Button>
                                </div>
                            </section>
                        )}
                    </aside>
                </div>

                {confirming ? (
                    <ConfirmDialog
                        model={() => confirm.scope !== null}
                        title={`Revoke ${confirming}?`}
                        description="Agents lose these tools on their next session. Sessions already running keep what they started with."
                        {...(lost.length ? { dependents: lost, dependentsLabel: `Tools · ${lost.length}` } : {})}
                        confirmLabel={`Revoke ${confirming}`}
                        cancelLabel="Keep granted"
                        onConfirm={confirmRevoke}
                        onCancel={() => { confirm.scope = null; }}
                    />
                ) : null}
            </div>
        );
    };
}, { name: 'PluginDetail' });
