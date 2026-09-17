/**
 * The Registry actor — `{ws}:registry` (architecture §4 Registry, §9;
 * PLG-01..05, EXE-10, AC-13).
 *
 * Holds the workspace's plugins (manifest, enabled, config,
 * grantedPermissions), its MCP connectors and its encrypted secrets.
 *
 * - `enable` / `disable` / `remove`: `disable` always succeeds and returns
 *   the dependents it leaves behind; `requireEnabled` then refuses every
 *   NEW use — a session about to start, a schedule about to fire — while
 *   running work finishes on its own (AC-13). `remove` refuses while
 *   anything depends on the plugin unless `force` is passed.
 * - `dependents(id)` reads the Workspace index and every Agent / Schedule it
 *   lists — hops, so the caller's principal rides along and no `authorize`
 *   re-runs on the hop.
 * - Secrets are sealed under `WORKSPACE_KEK` with an AAD of
 *   `{ws}:secret:{name}` and are only ever handed out by `openSecret`, which
 *   checks the plugin is enabled and holds the matching `secret:` grant
 *   (PLG-04). No read returns plaintext or ciphertext.
 *
 * Every mutation ends in `ctx.save()` inside the turn (Workers eviction rule).
 */

import type { AgentId, PermissionScope, PluginManifest, Principal, ScheduleId, WorkspaceId } from '@agentic/core';
import { defineActor, type ActorContext, type ActorPolicy } from '@sigx/actors';
import { AgentActor, agentKey, principalLabel } from '../agent/index.js';
import { recordAudit } from '../audit/port.js';
import type { AuditEventInput } from '../audit/events.js';
import { decryptSecret, encryptSecret, sameWorkspace, workspaceKey } from '../auth/index.js';
import { defineScheduleActor } from '../schedule/index.js';
import { Workspace } from '../workspace/index.js';
import { computeDependents, type AgentRef, type ScheduleRef } from './dependents.js';
import { PluginDisabledError, RegistryError } from './errors.js';
import { parseRegistryKey } from './key.js';
import { assertName, assertPluginManifest, declaredScopes, isPermissionScope, scopeCovered } from './manifest.js';
import {
    REGISTRY_STATE_VERSION,
    type ConnectorInput,
    type ConnectorRecord,
    type ConnectorStatus,
    type Dependents,
    type PluginRecord,
    type PluginView,
    type RegisterOptions,
    type RegistryExportRow,
    type RegistryState,
    type SecretInfo
} from './types.js';

export type KekSource = CryptoKey | Promise<CryptoKey> | (() => CryptoKey | Promise<CryptoKey>);

export interface RegistryOptions {
    /** `importWorkspaceKek(env.WORKSPACE_KEK)`. Without it `setSecret` / `openSecret` refuse with `no-kek`. */
    readonly kek?: KekSource;
    readonly now?: () => number;
    /** Override the policy chain. Default: the package's `sameWorkspace`. */
    readonly authorize?: ActorPolicy | readonly ActorPolicy[];
}

/** Mutations are the owner's alone; every same-workspace principal may read. */
const ownerOnly: ActorPolicy = (principal: Principal | null) => principal?.kind === 'user';
/** `openSecret`: the owner, or an agent principal minted for a session (tool callbacks). */
const ownerOrAgent: ActorPolicy = (principal: Principal | null) => principal?.kind === 'user' || principal?.kind === 'agent';

/**
 * A Schedule definition to hop with — the host resolves the target by
 * `type`, so the trigger here never runs; the app's `defineScheduleActor`
 * instance answers the call (same rule as a client-side `actor(Inbox, key)`).
 */
const ScheduleRefDef = defineScheduleActor({
    trigger: {
        fired() {
            throw new Error('[registry] ScheduleRefDef is a hop target, never a host');
        }
    }
});

const secretAad = (workspaceId: WorkspaceId, name: string): string => `${workspaceId}:secret:${name}`;

export function initialRegistryState(): RegistryState {
    return { v: REGISTRY_STATE_VERSION, plugins: {}, connectors: {}, secrets: {} };
}

export function defineRegistry(options: RegistryOptions = {}) {
    const now = options.now ?? (() => Date.now());
    const authorize: ActorPolicy | readonly ActorPolicy[] = options.authorize ?? sameWorkspace;
    let kekPromise: Promise<CryptoKey> | null = null;
    const kek = (): Promise<CryptoKey> => {
        if (options.kek === undefined) throw new RegistryError('no-kek', '[registry] no WORKSPACE_KEK configured: secrets cannot be stored');
        kekPromise ??= Promise.resolve(typeof options.kek === 'function' ? options.kek() : options.kek);
        return kekPromise;
    };

    type Ctx = ActorContext<RegistryState>;

    const workspaceOf = (ctx: Ctx): WorkspaceId => {
        const ws = parseRegistryKey(ctx.key);
        if (ws === null) throw new Error(`[registry] key must be "{ws}:registry", got "${ctx.key}"`);
        return ws;
    };

    const plugin = (ctx: Ctx, id: string): PluginRecord => {
        const p = ctx.state.plugins[id];
        if (!p) throw new PluginDisabledError(id, 'missing');
        return p;
    };

    const patchPlugin = (ctx: Ctx, id: string, patch: Partial<PluginRecord>): PluginRecord => {
        const next: PluginRecord = { ...plugin(ctx, id), ...patch, updatedAt: now() };
        ctx.state.plugins[id] = next;
        return next;
    };

    const view = (ctx: Ctx, p: PluginRecord): PluginView => ctx.snapshot(p);

    /** The audit record of a permission change or a secret leaving (OPS-03), one-way. */
    const audit = (ctx: Ctx, event: AuditEventInput): Promise<void> => recordAudit(ctx, workspaceOf(ctx), event);
    /** Distinguishes `openSecret` calls that share a millisecond within one activation. */
    let opened = 0;

    /** Read the Workspace index, then every agent and schedule it lists. */
    const collectRefs = async (ctx: Ctx): Promise<{ agents: AgentRef[]; schedules: ScheduleRef[] }> => {
        const ws = workspaceOf(ctx);
        const index = await ctx.actor(Workspace, workspaceKey(ws)).get();
        const agents: AgentRef[] = [];
        for (const id of index.agents) {
            const agent = await ctx.actor(AgentActor, agentKey(ws, id as AgentId)).get();
            agents.push({ id: agent.id, config: agent.config });
        }
        const schedules: ScheduleRef[] = [];
        for (const id of index.schedules) {
            try {
                const s = await ctx.actor(ScheduleRefDef, `${ws}:schedule:${id}`).get();
                schedules.push({ id: s.id as ScheduleId, title: s.title, ...(s.agentId !== undefined ? { agentId: s.agentId } : {}) });
            } catch {
                // Indexed but never created (or already gone): nothing depends through it.
            }
        }
        return { agents, schedules };
    };

    const dependents = async (ctx: Ctx, id: string): Promise<Dependents> => {
        const manifest = plugin(ctx, id).manifest;
        const { agents, schedules } = await collectRefs(ctx);
        return computeDependents(manifest, agents, schedules);
    };

    return defineActor({
        type: 'Registry',
        authorize,
        methodAuthorize: {
            register: [ownerOnly],
            enable: [ownerOnly],
            disable: [ownerOnly],
            remove: [ownerOnly],
            configure: [ownerOnly],
            grant: [ownerOnly],
            revoke: [ownerOnly],
            putConnector: [ownerOnly],
            removeConnector: [ownerOnly],
            setConnectorStatus: [ownerOnly],
            setSecret: [ownerOnly],
            deleteSecret: [ownerOnly],
            openSecret: [ownerOrAgent]
        },
        persistence: 'explicit',
        reads: { list: { maxAge: 0 }, connectors: { maxAge: 0 }, secrets: { maxAge: 0 } },
        methodReentrancy: { get: 'always', isEnabled: 'always', requireEnabled: 'always', getConnector: 'always', exportRows: 'always' },
        state: (): RegistryState => initialRegistryState(),
        methods: (ctx) => ({
            // -- plugins ------------------------------------------------------

            /** Every installed plugin, id order. A live read for the Plugins page. */
            list(): PluginView[] {
                return Object.keys(ctx.state.plugins)
                    .sort()
                    .map((id) => view(ctx, ctx.state.plugins[id]!));
            },

            async get(id: string): Promise<PluginView | null> {
                const p = ctx.state.plugins[id];
                return p ? view(ctx, p) : null;
            },

            async isEnabled(id: string): Promise<boolean> {
                return ctx.state.plugins[id]?.enabled === true;
            },

            /** The gate other actors call before NEW use of a plugin; throws `PluginDisabledError` (AC-13). */
            async requireEnabled(id: string): Promise<void> {
                const p = ctx.state.plugins[id];
                if (!p) throw new PluginDisabledError(id, 'missing');
                if (!p.enabled) throw new PluginDisabledError(id, 'disabled');
            },

            /**
             * Install or upgrade. Re-registering an id keeps `enabled`, `config`
             * and the grants that the new manifest still declares; a grant the
             * new version no longer asks for is dropped (PLG-04).
             */
            async register(manifest: PluginManifest, options: RegisterOptions = {}): Promise<PluginView> {
                assertPluginManifest(manifest);
                const at = now();
                const declared = declaredScopes(manifest);
                const existing = ctx.state.plugins[manifest.id];
                let wanted: readonly PermissionScope[];
                if (options.grant === 'declared') wanted = declared;
                else if (options.grant !== undefined) {
                    for (const scope of options.grant) {
                        if (!declared.includes(scope)) throw new RegistryError('not-declared', `[registry] "${manifest.id}" does not declare ${scope}`);
                    }
                    wanted = options.grant;
                } else {
                    // An upgrade keeps the grants the new manifest still asks for; the rest lapse.
                    wanted = (existing?.grantedPermissions ?? []).filter((s) => declared.includes(s));
                }
                const record: PluginRecord = {
                    manifest: ctx.snapshot(manifest),
                    enabled: options.enabled ?? existing?.enabled ?? false,
                    config: ctx.snapshot(options.config ?? existing?.config ?? {}),
                    grantedPermissions: [...new Set(wanted)],
                    registeredAt: existing?.registeredAt ?? at,
                    updatedAt: at
                };
                ctx.state.plugins[manifest.id] = record;
                await ctx.save();
                return view(ctx, record);
            },

            /** Recorded when it changes something: a plugin already enabled stays as it is, silently. */
            async enable(id: string): Promise<PluginView> {
                const was = plugin(ctx, id).enabled;
                const p = patchPlugin(ctx, id, { enabled: true });
                await ctx.save();
                if (!was) {
                    await audit(ctx, { key: `${ctx.key}:${id}:enabled:${p.updatedAt}`, kind: 'plugin.enabled', at: p.updatedAt, by: principalLabel(ctx.principal), summary: `plugin ${id} enabled`, data: { pluginId: id } });
                }
                return view(ctx, p);
            },

            /** Always succeeds; what still references the plugin comes back so the user sees it (AC-13). */
            async disable(id: string): Promise<{ plugin: PluginView; dependents: Dependents }> {
                const was = plugin(ctx, id).enabled;
                const p = patchPlugin(ctx, id, { enabled: false });
                await ctx.save();
                if (was) {
                    await audit(ctx, { key: `${ctx.key}:${id}:disabled:${p.updatedAt}`, kind: 'plugin.disabled', at: p.updatedAt, by: principalLabel(ctx.principal), summary: `plugin ${id} disabled`, data: { pluginId: id } });
                }
                return { plugin: view(ctx, p), dependents: await dependents(ctx, id) };
            },

            /** Refuses with `plugin-in-use` while agents or schedules depend on it, unless `force`. Drops its connectors too. */
            async remove(id: string, options: { readonly force?: boolean } = {}): Promise<{ removed: true; dependents: Dependents }> {
                plugin(ctx, id);
                const deps = await dependents(ctx, id);
                if (!options.force && (deps.agents.length > 0 || deps.schedules.length > 0)) {
                    throw new RegistryError(
                        'plugin-in-use',
                        `[registry] "${id}" is used by ${deps.agents.length} agent(s) and ${deps.schedules.length} schedule(s); disable it, or remove with force`
                    );
                }
                delete ctx.state.plugins[id];
                for (const c of Object.values(ctx.state.connectors)) if (c.pluginId === id) delete ctx.state.connectors[c.id];
                await ctx.save();
                return { removed: true, dependents: deps };
            },

            async configure(id: string, config: Record<string, unknown>): Promise<PluginView> {
                if (config === null || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('[registry] config must be an object');
                const p = patchPlugin(ctx, id, { config: ctx.snapshot(config) });
                await ctx.save();
                return view(ctx, p);
            },

            /** Grant declared scopes only — a scope the manifest never asked for is refused (PLG-04). */
            async grant(id: string, scopes: readonly PermissionScope[]): Promise<PluginView> {
                const p = plugin(ctx, id);
                const declared = declaredScopes(p.manifest);
                for (const scope of scopes) {
                    if (!isPermissionScope(scope)) throw new RegistryError('not-declared', `[registry] not a permission scope: ${String(scope)}`);
                    if (!declared.includes(scope)) throw new RegistryError('not-declared', `[registry] "${id}" does not declare ${scope}`);
                }
                const added = [...new Set(scopes)].filter((s) => !p.grantedPermissions.includes(s));
                const next = patchPlugin(ctx, id, { grantedPermissions: [...new Set([...p.grantedPermissions, ...scopes])] });
                await ctx.save();
                // Recorded with the scopes that are NEW; re-granting what was already held changes nothing.
                if (added.length > 0) {
                    await audit(ctx, {
                        key: `${ctx.key}:${id}:granted:${next.updatedAt}:${added.join(',')}`,
                        kind: 'plugin.granted',
                        at: next.updatedAt,
                        by: principalLabel(ctx.principal),
                        summary: `plugin ${id} granted ${added.join(', ')}`,
                        data: { pluginId: id, scopes: added }
                    });
                }
                return view(ctx, next);
            },

            async revoke(id: string, scopes: readonly PermissionScope[]): Promise<PluginView> {
                const p = plugin(ctx, id);
                const drop = new Set<string>(scopes);
                const next = patchPlugin(ctx, id, { grantedPermissions: p.grantedPermissions.filter((s) => !drop.has(s)) });
                await ctx.save();
                return view(ctx, next);
            },

            async dependents(id: string): Promise<Dependents> {
                return dependents(ctx, id);
            },

            // -- connectors ---------------------------------------------------

            connectors(): ConnectorRecord[] {
                return Object.keys(ctx.state.connectors)
                    .sort()
                    .map((id) => ctx.snapshot(ctx.state.connectors[id]!));
            },

            async getConnector(id: string): Promise<ConnectorRecord | null> {
                const c = ctx.state.connectors[id];
                return c ? ctx.snapshot(c) : null;
            },

            /** Create or replace. The plugin must be installed; discovered tools and status survive a replace. */
            async putConnector(input: ConnectorInput): Promise<ConnectorRecord> {
                assertName(input.id, 'connector id');
                plugin(ctx, input.pluginId);
                if (input.transport === 'streamable-http' && typeof input.url !== 'string') throw new TypeError('[registry] an http connector needs a url');
                if (input.transport === 'stdio' && typeof input.command !== 'string') throw new TypeError('[registry] a stdio connector needs a command');
                for (const s of input.secrets ?? []) assertName(s, 'secret name');
                const existing = ctx.state.connectors[input.id];
                const record: ConnectorRecord = {
                    ...ctx.snapshot(input),
                    tools: [...(input.tools ?? existing?.tools ?? [])],
                    status: existing?.status ?? { state: 'unknown' },
                    updatedAt: now()
                };
                ctx.state.connectors[input.id] = record;
                await ctx.save();
                return ctx.snapshot(record);
            },

            async removeConnector(id: string): Promise<boolean> {
                if (!ctx.state.connectors[id]) return false;
                delete ctx.state.connectors[id];
                await ctx.save();
                return true;
            },

            /** Record a probe: what `tools/list` returned, or why it failed. */
            async setConnectorStatus(id: string, status: ConnectorStatus, tools?: readonly string[]): Promise<ConnectorRecord> {
                const c = ctx.state.connectors[id];
                if (!c) throw new RegistryError('connector-missing', `[registry] no connector "${id}"`);
                const next: ConnectorRecord = { ...c, status: { ...status, checkedAt: status.checkedAt ?? now() }, tools: tools ? [...tools] : c.tools, updatedAt: now() };
                ctx.state.connectors[id] = next;
                await ctx.save();
                return ctx.snapshot(next);
            },

            // -- secrets ------------------------------------------------------

            /** Seal `value` under the workspace KEK, bound to this workspace and name. Never echoed back. */
            async setSecret(name: string, value: string): Promise<SecretInfo> {
                assertName(name, 'secret name');
                if (typeof value !== 'string' || value === '') throw new TypeError('[registry] a secret needs a non-empty value');
                const sealed = await encryptSecret(await kek(), value, secretAad(workspaceOf(ctx), name));
                const record = { sealed, updatedAt: now() };
                ctx.state.secrets[name] = record;
                await ctx.save();
                return { name, updatedAt: record.updatedAt };
            },

            async deleteSecret(name: string): Promise<boolean> {
                if (!ctx.state.secrets[name]) return false;
                delete ctx.state.secrets[name];
                await ctx.save();
                return true;
            },

            /** Names and timestamps only. */
            secrets(): SecretInfo[] {
                return Object.keys(ctx.state.secrets)
                    .sort()
                    .map((name) => ({ name, updatedAt: ctx.state.secrets[name]!.updatedAt }));
            },

            /**
             * The plaintext for a plugin that is enabled AND holds `secret:<name>`
             * (or `secret:*`) — the only way a secret leaves the actor (PLG-04).
             */
            async openSecret(name: string, pluginId: string): Promise<string> {
                const p = plugin(ctx, pluginId);
                if (!p.enabled) throw new PluginDisabledError(pluginId, 'disabled');
                if (!scopeCovered(p.grantedPermissions, `secret:${name}`)) {
                    throw new RegistryError('secret-denied', `[registry] "${pluginId}" was not granted secret:${name}`);
                }
                const record = ctx.state.secrets[name];
                if (!record) throw new RegistryError('secret-missing', `[registry] no secret "${name}"`);
                const value = await decryptSecret(await kek(), record.sealed, secretAad(workspaceOf(ctx), name));
                // Every release of plaintext is an occurrence (OPS-03): no idempotency to lean on, so the key is the instant plus a counter.
                const at = now();
                await audit(ctx, { key: `${ctx.key}:secret:${name}:${pluginId}:${at}:${opened++}`, kind: 'secret.opened', at, by: principalLabel(ctx.principal), summary: `secret ${name} opened for plugin ${pluginId}`, data: { name, pluginId } });
                return value;
            },

            // -- export -------------------------------------------------------

            /** NDJSON rows for `Workspace.exportAll`: plugins, connectors, secret NAMES. */
            async exportRows(): Promise<RegistryExportRow[]> {
                const rows: RegistryExportRow[] = [];
                for (const id of Object.keys(ctx.state.plugins).sort()) rows.push({ kind: 'plugin', plugin: ctx.snapshot(ctx.state.plugins[id]!) });
                for (const id of Object.keys(ctx.state.connectors).sort()) rows.push({ kind: 'connector', connector: ctx.snapshot(ctx.state.connectors[id]!) });
                for (const name of Object.keys(ctx.state.secrets).sort()) rows.push({ kind: 'secret', secret: { name, updatedAt: ctx.state.secrets[name]!.updatedAt } });
                return rows;
            }
        })
    });
}

/** The Registry with no KEK: everything but secrets. The app registers `defineRegistry({ kek })`. */
export const Registry = defineRegistry();

export type RegistryActor = ReturnType<typeof defineRegistry>;
