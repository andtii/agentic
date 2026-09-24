/**
 * The Registry actor — `{ws}:registry` (architecture §4 Registry, §9;
 * PLG-01..05, EXE-10, AC-13).
 *
 * Holds the workspace's plugins (manifest, enabled, config,
 * grantedPermissions), its MCP connectors and its encrypted secrets.
 *
 * - The CATALOGUE is what the build ships (`defineRegistry({ catalogue })`).
 *   A built-in is virtual until touched: a workspace that never mutated it
 *   stores nothing and reads the catalogue default — enabled, every declared
 *   scope granted, config at the schema's defaults (PLG-05; decisions
 *   2026-09-19 (a)). No read ever saves; the first mutation materialises the
 *   record and saves it in that turn. A stored built-in always reads with the
 *   build's manifest: grants it no longer declares lapse, a scope no build
 *   had declared before is granted once (`seenScopes`), and one the owner
 *   revoked stays revoked.
 * - `configure` holds a config to the manifest's `ConfigSchema` (`bad-config`).
 * - Single-slot kinds (memory, learning) have one ACTIVE plugin: the owner's
 *   `activate` choice, else the first of the kind in the catalogue.
 * - `setToolPolicy` stores the workspace-default allow / ask / deny of one of
 *   a plugin's tools (PLG-03); `toolPolicy` reads the effective map — the
 *   stored mode, else the manifest's `defaultMode`, else `'allow'` — and
 *   `gate` hands a connector's ask / deny entries to Routing.
 * - `gate` answers Routing in one hop; `overview` and `dependentsAll` answer
 *   a page in one read each.
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

import { configDefaults, isProjectFeatureManifest, isSingleSlot, validateConfig, type AgentId, type PermissionScope, type PluginKind, type PluginManifest, type Principal, type ScheduleId, type ToolMode, type WorkspaceId } from '@agentic/core';
import { defineActor, type ActorContext, type ActorPolicy } from '@sigx/actors';
import { ServerFnError } from '@sigx/server';
import { AgentActor, agentKey, principalLabel } from '../agent/index.js';
import { recordAudit } from '../audit/port.js';
import type { AuditEventInput } from '../audit/events.js';
import { decryptSecret, encryptSecret, sameWorkspace, workspaceKey } from '../auth/index.js';
import { workspaceMemoryScopes, switchMemory, type MemorySwitchReport } from '../memory/switch.js';
import { defineScheduleActor } from '../schedule/index.js';
import type { MemoryPluginImpl } from '../task/driver.js';
import { Workspace } from '../workspace/index.js';
import { computeDependents, type AgentRef, type ScheduleRef } from './dependents.js';
import { BadConfigError, PluginDisabledError, RegistryError } from './errors.js';
import { parseRegistryKey } from './key.js';
import { assertName, assertPluginManifest, declaredScopes, isPermissionScope, isToolMode, scopeCovered, grantedNetworkHosts } from './manifest.js';
import {
    REGISTRY_STATE_VERSION,
    type CatalogueEntry,
    type ConnectorInput,
    type ConnectorRecord,
    type ConnectorStatus,
    type Dependents,
    type GateConnector,
    type GateEntry,
    type PluginRecord,
    type PluginView,
    type RegisterOptions,
    type RegistryExportRow,
    type RegistryGate,
    type RegistryOverview,
    type RegistryState,
    type SecretInfo,
    type SlotKind
} from './types.js';

export type KekSource = CryptoKey | Promise<CryptoKey> | (() => CryptoKey | Promise<CryptoKey>);

export interface RegistryOptions {
    /** `importWorkspaceKek(env.WORKSPACE_KEK)`. Without it `setSecret` / `openSecret` refuse with `no-kek`. */
    readonly kek?: KekSource;
    /**
     * The plugins this build ships, in the order the app lists them — the first
     * of a single-slot kind is that slot's default. Checked here, so a bad
     * manifest fails the build's start and never a request.
     */
    readonly catalogue?: readonly CatalogueEntry[];
    /**
     * The memory plugins this build implements, by id (`memoryCatalogue`): what `previewActivation` and
     * `activate('memory', id, { migrate: true })` move the memories between (#243). Without both ends, a
     * migrating switch refuses with `no-migration`.
     */
    readonly memoryPlugins?: Readonly<Record<string, MemoryPluginImpl>>;
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

const union = <T>(a: readonly T[], b: readonly T[]): T[] => [...new Set([...a, ...b])];

export function defineRegistry(options: RegistryOptions = {}) {
    const now = options.now ?? (() => Date.now());
    const catalogue = new Map<string, { readonly manifest: PluginManifest; readonly enabledByDefault: boolean }>();
    for (const entry of options.catalogue ?? []) {
        const manifest = 'manifest' in entry ? entry.manifest : entry;
        assertPluginManifest(manifest);
        if (catalogue.has(manifest.id)) throw new RegistryError('bad-manifest', `[registry] the catalogue lists "${manifest.id}" twice`);
        catalogue.set(manifest.id, { manifest, enabledByDefault: ('manifest' in entry ? entry.enabledByDefault : undefined) ?? true });
    }
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

    /**
     * The record as it stands in THIS build, `config` as stored (the owner's
     * values only). A built-in reads through the catalogue: no record → the
     * default; a record → the build's manifest over it. Pure — never writes.
     */
    const current = (ctx: Ctx, id: string): PluginRecord | undefined => {
        const stored = ctx.state.plugins[id];
        const entry = catalogue.get(id);
        if (!entry) return stored;
        const declared = declaredScopes(entry.manifest);
        if (!stored) return { manifest: entry.manifest, enabled: entry.enabledByDefault, config: {}, grantedPermissions: declared, seenScopes: declared, registeredAt: 0, updatedAt: 0 };
        // A record from before `seenScopes` has seen what its own manifest declared.
        const seen = stored.seenScopes ?? declaredScopes(stored.manifest);
        const kept = stored.grantedPermissions.filter((s) => declared.includes(s));
        return { ...stored, manifest: entry.manifest, grantedPermissions: union(kept, declared.filter((s) => !seen.includes(s))), seenScopes: union(seen, declared) };
    };

    /** Every plugin the workspace has: stored ones and the build's, id order. */
    const pluginIds = (ctx: Ctx): string[] => union(Object.keys(ctx.state.plugins), [...catalogue.keys()]).sort();

    const plugin = (ctx: Ctx, id: string): PluginRecord => {
        const p = current(ctx, id);
        if (!p) throw new PluginDisabledError(id, 'missing');
        return p;
    };

    /** The one write path for a plugin record — what materialises a built-in. The caller saves. */
    const patchPlugin = (ctx: Ctx, id: string, patch: Partial<PluginRecord>): PluginRecord => {
        const at = now();
        const base = plugin(ctx, id);
        const next: PluginRecord = { ...base, ...patch, registeredAt: base.registeredAt || at, updatedAt: at };
        // The catalogue's manifest is shared by every workspace of the isolate: state gets its own copy.
        ctx.state.plugins[id] = catalogue.has(id) ? { ...next, manifest: ctx.snapshot(next.manifest) } : next;
        return next;
    };

    const mergedConfig = (p: PluginRecord): Record<string, unknown> => ({ ...configDefaults(p.manifest.config), ...p.config });

    /**
     * Hold `config` to the manifest's schema, defaults filled in, and answer what to STORE: the owner's own
     * keys, `undefined` dropped, rebuilt with `Object.fromEntries` so a `__proto__` key stays data — as core does.
     */
    const checkConfig = (manifest: PluginManifest, config: Record<string, unknown>): Record<string, unknown> => {
        const own = Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined));
        const checked = validateConfig(manifest.config, { ...configDefaults(manifest.config), ...own });
        if (!checked.ok) throw new BadConfigError(manifest.id, checked.errors);
        const hostError = connectorUrlHostError(manifest, checked.value);
        if (hostError) throw new BadConfigError(manifest.id, [hostError]);
        return own;
    };

    /**
     * A connector's `url` must stay on a host its manifest declares a `network:` scope for (#642; PLG-04): the host is
     * fenced by that grant, and a scope the manifest does not declare can never be granted — so a URL moved to a new
     * host would leave the connector unreachable with no way to fix it on its page. Refused here instead, saying to add
     * the connector again. A connector that declares no `network:` scope is not fenced and not checked.
     */
    const connectorUrlHostError = (manifest: PluginManifest, config: Record<string, unknown>): { path: string; message: string } | undefined => {
        if (manifest.kind !== 'connector' || typeof config.url !== 'string') return undefined;
        const declared = declaredScopes(manifest);
        if (!declared.some((s) => s.startsWith('network:'))) return undefined;
        let url: URL;
        try {
            url = new URL(config.url);
        } catch {
            return undefined;
        }
        if (scopeCovered(declared, `network:${url.host}`) || scopeCovered(declared, `network:${url.hostname}`)) return undefined;
        return { path: 'url', message: `${url.host} is not a host this connector was added with (it declares no network:${url.host} permission); to use another server, add the connector again` };
    };

    /** The plugin a single-slot kind runs on: the owner's choice while it exists, else the catalogue's first, else the first installed. */
    const activeOf = (ctx: Ctx, kind: PluginKind): string | undefined => {
        const chosen = ctx.state.active?.[kind as SlotKind];
        if (chosen !== undefined && current(ctx, chosen)?.manifest.kind === kind) return chosen;
        for (const [id, entry] of catalogue) if (entry.manifest.kind === kind) return id;
        return pluginIds(ctx).find((id) => current(ctx, id)!.manifest.kind === kind);
    };

    const activeSlots = (ctx: Ctx): Partial<Record<SlotKind, string>> => {
        const memory = activeOf(ctx, 'memory');
        const learning = activeOf(ctx, 'learning');
        return { ...(memory !== undefined ? { memory } : {}), ...(learning !== undefined ? { learning } : {}) };
    };

    const isActive = (ctx: Ctx, p: PluginRecord): boolean => isSingleSlot(p.manifest.kind) && activeOf(ctx, p.manifest.kind) === p.manifest.id;

    const view = (ctx: Ctx, p: PluginRecord): PluginView =>
        ctx.snapshot({
            ...p,
            config: mergedConfig(p),
            builtin: catalogue.has(p.manifest.id),
            ...(isSingleSlot(p.manifest.kind) ? { active: isActive(ctx, p) } : {})
        });

    const gateEntry = (ctx: Ctx, id: string | undefined): GateEntry | null => {
        const p = id === undefined ? undefined : current(ctx, id);
        return p ? { id: p.manifest.id, enabled: p.enabled, config: mergedConfig(p) } : null;
    };

    /** Every tool a plugin brings, sorted: the ones its manifest declares and the ones its connectors reported. */
    const toolsOf = (ctx: Ctx, p: PluginRecord): string[] => {
        const reported = Object.values(ctx.state.connectors).flatMap((c) => (c.pluginId === p.manifest.id ? c.tools : []));
        return union((p.manifest.tools ?? []).map((t) => t.name), reported).sort();
    };

    /** The effective mode of every tool of `p` (PLG-03): what the owner stored, else the manifest's `defaultMode`, else `'allow'`. */
    const effectiveToolPolicy = (ctx: Ctx, p: PluginRecord): Record<string, ToolMode> => {
        const declared = new Map((p.manifest.tools ?? []).map((t) => [t.name, t.defaultMode] as const));
        const stored = p.toolPolicy ?? {};
        return Object.fromEntries(toolsOf(ctx, p).map((tool) => [tool, (Object.hasOwn(stored, tool) ? stored[tool] : undefined) ?? declared.get(tool) ?? 'allow']));
    };

    /** Only what is NOT allowed: a session asks before (`ask`) or refuses (`deny`) these; everything else runs. */
    const restrictedTools = (ctx: Ctx, p: PluginRecord): Record<string, Exclude<ToolMode, 'allow'>> =>
        Object.fromEntries(Object.entries(effectiveToolPolicy(ctx, p)).filter((e): e is [string, Exclude<ToolMode, 'allow'>] => e[1] !== 'allow'));

    /**
     * Whether the owner let the plugin expose its tools (PLG-04): every `tools:<ns>` scope its manifest declares is
     * covered by its grants — `tools:<id>` when it declares none, which only a `tools:*` grant could cover.
     */
    const toolsGranted = (p: PluginRecord): boolean => {
        const declared = declaredScopes(p.manifest).filter((s) => s.startsWith('tools:'));
        const wanted = declared.length > 0 ? declared : [`tools:${p.manifest.id}` as PermissionScope];
        return wanted.every((scope) => scopeCovered(p.grantedPermissions, scope));
    };

    /** The hosts of the plugin's granted `network:<host>` scopes (PLG-04): what its connector may reach (#642). Absent under `network:*`. */
    const networkHosts = (p: PluginRecord): { networkHosts?: string[] } => {
        const hosts = grantedNetworkHosts(p.grantedPermissions);
        return hosts === undefined ? {} : { networkHosts: hosts };
    };

    /**
     * A connector an agent names, as a session would open it (#240): its record and its plugin, looked up by the
     * connector id — or, for a ref naming the plugin, the first connector registered under it.
     */
    const gateConnector = (ctx: Ctx, id: string): GateConnector => {
        const record = ctx.state.connectors[id] ?? Object.values(ctx.state.connectors).find((c) => c.pluginId === id);
        const p = record ? current(ctx, record.pluginId) : undefined;
        if (!record || !p || p.manifest.kind !== 'connector') return { id, state: 'missing' };
        if (!p.enabled) return { id, state: 'disabled', pluginId: p.manifest.id };
        // A conduit connector (#530) is opened by the platform from the ids alone: no endpoint, no secret names.
        if (record.transport === 'conduit') {
            return {
                id: record.id,
                state: 'ready',
                pluginId: p.manifest.id,
                transport: 'conduit',
                ...(record.connector !== undefined ? { connector: record.connector } : {}),
                ...(record.account !== undefined ? { account: record.account } : {}),
                tools: record.tools,
                status: record.status,
                toolPolicy: restrictedTools(ctx, p),
                toolsGranted: toolsGranted(p),
                ...networkHosts(p)
            };
        }
        const config = mergedConfig(p);
        const url = typeof config['url'] === 'string' ? config['url'] : record.url;
        const command = typeof config['command'] === 'string' ? config['command'] : record.command;
        const args = Array.isArray(config['args']) ? (config['args'] as string[]) : record.args;
        const cwd = typeof config['cwd'] === 'string' && config['cwd'] !== '' ? config['cwd'] : undefined;
        // A record written before #240 names its secrets without saying where they go: an http one sent the first as its bearer.
        const auth = record.auth ?? (record.transport === 'streamable-http' && record.secrets?.[0] !== undefined ? { bearer: record.secrets[0] } : undefined);
        return {
            id: record.id,
            state: 'ready',
            pluginId: p.manifest.id,
            transport: record.transport,
            ...(url !== undefined ? { url } : {}),
            ...(command !== undefined ? { command } : {}),
            ...(args !== undefined ? { args } : {}),
            ...(cwd !== undefined ? { cwd } : {}),
            ...(record.machine !== undefined ? { machine: record.machine } : {}),
            ...(auth ? { auth } : {}),
            tools: record.tools,
            status: record.status,
            toolPolicy: restrictedTools(ctx, p),
            toolsGranted: toolsGranted(p),
            ...networkHosts(p)
        };
    };

    /** The audit record of a permission change or a secret leaving (OPS-03), one-way. */
    const audit = (ctx: Ctx, event: AuditEventInput): Promise<void> => recordAudit(ctx, workspaceOf(ctx), event);
    /** Distinguishes `openSecret` calls that share a millisecond within one activation. */
    let opened = 0;
    /** Distinguishes permission / tool-policy changes that share a millisecond within one activation (OPS-03). */
    let changed = 0;

    type Refs = { readonly agents: readonly AgentRef[]; readonly schedules: readonly ScheduleRef[] };

    /** Read the Workspace index, then every agent and schedule it lists — side by side, index order kept. */
    const collectRefs = async (ctx: Ctx): Promise<Refs> => {
        const ws = workspaceOf(ctx);
        const index = await ctx.actor(Workspace, workspaceKey(ws)).get();
        const [agents, schedules] = await Promise.all([
            Promise.all(
                index.agents.map(async (id): Promise<AgentRef> => {
                    const agent = await ctx.actor(AgentActor, agentKey(ws, id as AgentId)).get();
                    return { id: agent.id, config: agent.config };
                })
            ),
            Promise.all(
                index.schedules.map(async (id): Promise<ScheduleRef | null> => {
                    try {
                        const s = await ctx.actor(ScheduleRefDef, `${ws}:schedule:${id}`).get();
                        return { id: s.id as ScheduleId, title: s.title, ...(s.agentId !== undefined ? { agentId: s.agentId } : {}) };
                    } catch {
                        // Indexed but never created (or already gone): nothing depends through it.
                        return null;
                    }
                })
            )
        ]);
        return { agents, schedules: schedules.filter((s): s is ScheduleRef => s !== null) };
    };

    const dependentsOf = (ctx: Ctx, p: PluginRecord, refs: Refs): Dependents => computeDependents(p.manifest, refs.agents, refs.schedules, { workspaceWide: isActive(ctx, p) });

    const dependents = async (ctx: Ctx, id: string): Promise<Dependents> => {
        plugin(ctx, id);
        const refs = await collectRefs(ctx);
        // Read the record after the walk: it awaited, and the plugin may have moved meanwhile.
        return dependentsOf(ctx, plugin(ctx, id), refs);
    };

    const exportOf = (p: PluginRecord): 'full' | 'partial' => (p.manifest.capabilities.includes('export:partial') ? 'partial' : 'full');

    /**
     * Move the memories of every scope the workspace implies from the ACTIVE memory plugin into `id` (#243) — or, as
     * a dry run, report what that would keep and drop. Reads and writes as the caller, the owner. A failure is
     * `migration-failed`; the caller switches nothing then.
     */
    const moveMemories = async (ctx: Ctx, id: string, dryRun: boolean): Promise<MemorySwitchReport> => {
        const target = plugin(ctx, id);
        if (target.manifest.kind !== 'memory') throw new RegistryError('wrong-kind', `[registry] "${id}" is a ${target.manifest.kind} plugin, not memory`);
        const fromId = activeOf(ctx, 'memory');
        if (fromId === undefined || fromId === id) return { from: fromId ?? id, to: id, dryRun, targetExport: exportOf(target), entries: 0, imported: 0, skipped: 0, droppedFields: [], scopes: [] };
        const fromImpl = options.memoryPlugins?.[fromId];
        const toImpl = options.memoryPlugins?.[id];
        if (!fromImpl || !toImpl) throw new RegistryError('no-migration', `[registry] this build cannot move memories from "${fromId}" to "${id}"`);
        const source = plugin(ctx, fromId);
        const principal = (ctx.principal as Principal | null | undefined) ?? null;
        if (!principal) throw new RegistryError('no-migration', '[registry] moving memories needs the owner as the caller');
        const refs = await collectRefs(ctx);
        const scopes = workspaceMemoryScopes(refs.agents.map((a) => ({ id: a.id, shared: a.config.memoryPolicy.shared })));
        try {
            return await switchMemory({
                from: { id: fromId, memory: fromImpl(mergedConfig(source)) },
                to: { id, memory: toImpl(mergedConfig(target)), export: exportOf(target) },
                scopes,
                principal,
                dryRun
            });
        } catch (e) {
            const why = e instanceof Error ? e.message : String(e);
            throw new RegistryError('migration-failed', `[registry] ${dryRun ? 'checking the move of' : 'moving'} the memories to "${id}" failed, so "${fromId}" stays active: ${why}`);
        }
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
            activate: [ownerOnly],
            previewActivation: [ownerOnly],
            grant: [ownerOnly],
            revoke: [ownerOnly],
            setToolPolicy: [ownerOnly],
            putConnector: [ownerOnly],
            removeConnector: [ownerOnly],
            setConnectorStatus: [ownerOnly],
            setSecret: [ownerOnly],
            deleteSecret: [ownerOnly],
            openSecret: [ownerOrAgent]
        },
        persistence: 'explicit',
        reads: { list: { maxAge: 0 }, overview: { maxAge: 0 }, connectors: { maxAge: 0 }, secrets: { maxAge: 0 }, toolPolicy: { maxAge: 0 } },
        methodReentrancy: { get: 'always', isEnabled: 'always', requireEnabled: 'always', gate: 'always', getConnector: 'always', exportRows: 'always', checkProjectSettings: 'always' },
        state: (): RegistryState => initialRegistryState(),
        methods: (ctx) => ({
            // -- plugins ------------------------------------------------------

            /** Every plugin — the build's and the installed ones — id order. A live read for the Plugins page. */
            list(): PluginView[] {
                return pluginIds(ctx).map((id) => view(ctx, current(ctx, id)!));
            },

            /** What a page needs in one live read: the plugins, the active slots, which secrets are set (the facts `pluginReadiness` takes). */
            overview(): RegistryOverview {
                return {
                    plugins: pluginIds(ctx).map((id) => view(ctx, current(ctx, id)!)),
                    active: activeSlots(ctx),
                    secretNames: Object.keys(ctx.state.secrets).sort(),
                    hasKek: options.kek !== undefined
                };
            },

            async get(id: string): Promise<PluginView | null> {
                const p = current(ctx, id);
                return p ? view(ctx, p) : null;
            },

            async isEnabled(id: string): Promise<boolean> {
                return current(ctx, id)?.enabled === true;
            },

            /** The gate other actors call before NEW use of a plugin; throws `PluginDisabledError` (AC-13). */
            async requireEnabled(id: string): Promise<void> {
                if (!plugin(ctx, id).enabled) throw new PluginDisabledError(id, 'disabled');
            },

            /**
             * Whether a project may store `settings` under `features[pluginId]` (#332): the plugin must exist, be
             * enabled and be a project feature, and the settings — defaults filled in — must pass its
             * `projectSettings` schema. A 400 says which; `Workspace.upsertProject` asks over a hop.
             */
            async checkProjectSettings(pluginId: string, settings: Readonly<Record<string, unknown>>): Promise<void> {
                const p = current(ctx, pluginId);
                if (!p) throw new ServerFnError(400, `[registry] no plugin "${pluginId}" is installed in this workspace`);
                if (!p.enabled) throw new ServerFnError(400, `[registry] plugin "${pluginId}" is turned off; turn it on at /plugins/${pluginId}`);
                if (!isProjectFeatureManifest(p.manifest)) throw new ServerFnError(400, `[registry] "${pluginId}" is a ${p.manifest.kind} plugin, not a project feature`);
                if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) throw new ServerFnError(400, `[registry] the settings of "${pluginId}" must be an object`);
                const own = Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined));
                const checked = validateConfig(p.manifest.projectSettings, { ...configDefaults(p.manifest.projectSettings), ...own });
                if (!checked.ok) throw new ServerFnError(400, `[registry] the settings of "${pluginId}" are invalid: ${checked.errors.map((e) => `${e.path || '.'}: ${e.message}`).join('; ')}`);
            },

            /**
             * Everything `Routing.run` asks before NEW work, in one hop: the runtime
             * plugin (`null` when no runtime plugin has that id), the active memory
             * and learning plugins, the enabled notification channels — each
             * `config` ready to use. It reports and never throws: what a disabled
             * plugin means is the caller's call.
             */
            async gate(input: { readonly runtime?: string; readonly connectors?: readonly string[] } = {}): Promise<RegistryGate> {
                const runtime = input.runtime !== undefined && current(ctx, input.runtime)?.manifest.kind === 'runtime' ? gateEntry(ctx, input.runtime) : null;
                const channels = pluginIds(ctx)
                    .map((id) => current(ctx, id)!)
                    .filter((p) => p.manifest.kind === 'notification' && p.enabled)
                    .map((p) => ({ id: p.manifest.id, config: mergedConfig(p) }));
                const connectors = input.connectors ? [...new Set(input.connectors)].map((id) => gateConnector(ctx, id)) : undefined;
                return ctx.snapshot({ runtime, memory: gateEntry(ctx, activeOf(ctx, 'memory')), learning: gateEntry(ctx, activeOf(ctx, 'learning')), channels, ...(connectors ? { connectors } : {}) });
            },

            /**
             * Install or upgrade. Re-registering an id keeps `enabled`, `config`
             * and the grants that the new manifest still declares; a grant the
             * new version no longer asks for is dropped (PLG-04).
             */
            async register(manifest: PluginManifest, options: RegisterOptions = {}): Promise<PluginView> {
                assertPluginManifest(manifest);
                if (catalogue.has(manifest.id)) throw new RegistryError('builtin', `[registry] "${manifest.id}" ships with the build: it cannot be registered over`);
                const config = options.config !== undefined ? checkConfig(manifest, options.config) : undefined;
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
                    config: ctx.snapshot(config ?? existing?.config ?? {}),
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
                const kind = plugin(ctx, id).manifest.kind;
                if (catalogue.has(id)) throw new RegistryError('builtin', `[registry] "${id}" ships with the build: disable it instead`);
                const deps = await dependents(ctx, id);
                if (!options.force && (deps.agents.length > 0 || deps.schedules.length > 0 || deps.workspaceWide)) {
                    throw new RegistryError(
                        'plugin-in-use',
                        deps.workspaceWide
                            ? `[registry] "${id}" is the workspace's active ${kind} plugin; activate another, or remove with force`
                            : `[registry] "${id}" is used by ${deps.agents.length} agent(s) and ${deps.schedules.length} schedule(s); disable it, or remove with force`
                    );
                }
                delete ctx.state.plugins[id];
                for (const c of Object.values(ctx.state.connectors)) if (c.pluginId === id) delete ctx.state.connectors[c.id];
                await ctx.save();
                return { removed: true, dependents: deps };
            },

            /** Replace the plugin's config. Held to the manifest's schema with its defaults filled in: `bad-config` names every path, and nothing is stored. */
            async configure(id: string, config: Record<string, unknown>): Promise<PluginView> {
                if (config === null || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('[registry] config must be an object');
                const own = checkConfig(plugin(ctx, id).manifest, config);
                const p = patchPlugin(ctx, id, { config: ctx.snapshot(own) });
                await ctx.save();
                return view(ctx, p);
            },

            /**
             * Make `id` the plugin its single-slot kind runs on — for NEW sessions,
             * like every other switch here. Refuses another kind, and a plugin that
             * is missing or disabled. Recorded when it changes something.
             *
             * `{ migrate: true }` (memory only, #243) first moves every scope's
             * memories from the active plugin into `id` and verifies the counts;
             * `active` flips last, so a failure (`migration-failed`) leaves the old
             * plugin active. What was already copied stays in the new store, and the
             * old store is never touched. `previewActivation` is the same move as a
             * dry run.
             */
            async activate(kind: SlotKind, id: string, options: { readonly migrate?: boolean } = {}): Promise<PluginView & { readonly migration?: MemorySwitchReport }> {
                if (!isSingleSlot(kind)) throw new RegistryError('wrong-kind', `[registry] "${String(kind)}" is not a single-slot kind`);
                const p = plugin(ctx, id);
                if (p.manifest.kind !== kind) throw new RegistryError('wrong-kind', `[registry] "${id}" is a ${p.manifest.kind} plugin, not ${kind}`);
                if (!p.enabled) throw new PluginDisabledError(id, 'disabled');
                const previous = activeOf(ctx, kind);
                if (previous === id) return view(ctx, p);
                if (options.migrate && kind !== 'memory') throw new RegistryError('wrong-kind', `[registry] only memory plugins hold data to move; activate "${id}" without migrate`);
                const migration = options.migrate ? await moveMemories(ctx, id, false) : undefined;
                // The move awaited: the plugin may have been turned off meanwhile.
                if (migration && !plugin(ctx, id).enabled) throw new PluginDisabledError(id, 'disabled');
                ctx.state.active = { ...ctx.state.active, [kind]: id };
                await ctx.save();
                const at = now();
                await audit(ctx, {
                    key: `${ctx.key}:${id}:activated:${at}`,
                    kind: 'plugin.activated',
                    at,
                    by: principalLabel(ctx.principal),
                    summary: migration
                        ? `plugin ${id} made the active ${kind} plugin; ${migration.imported} of ${migration.entries} memories moved from ${migration.from}${migration.droppedFields.length ? ` (dropped: ${migration.droppedFields.join(', ')})` : ''}`
                        : `plugin ${id} made the active ${kind} plugin`,
                    data: { pluginId: id, kind, ...(previous !== undefined ? { previous } : {}) }
                });
                return { ...view(ctx, plugin(ctx, id)), ...(migration ? { migration } : {}) };
            },

            /**
             * What `activate('memory', id, { migrate: true })` would move (#243, MEM-09): every scope's entries,
             * what the target would skip, and the fields it cannot hold — nothing is written. The page shows this
             * before it asks for confirmation.
             */
            async previewActivation(kind: SlotKind, id: string): Promise<MemorySwitchReport> {
                if (kind !== 'memory') throw new RegistryError('wrong-kind', `[registry] only memory plugins hold data to move`);
                return moveMemories(ctx, id, true);
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

            /** Revoke declared scopes only, like `grant` (`not-declared`). Recorded with the scopes it actually took away (OPS-03). */
            async revoke(id: string, scopes: readonly PermissionScope[]): Promise<PluginView> {
                const p = plugin(ctx, id);
                const declared = declaredScopes(p.manifest);
                for (const scope of scopes) {
                    if (!isPermissionScope(scope)) throw new RegistryError('not-declared', `[registry] not a permission scope: ${String(scope)}`);
                    if (!declared.includes(scope)) throw new RegistryError('not-declared', `[registry] "${id}" does not declare ${scope}`);
                }
                const drop = new Set<string>(scopes);
                const removed = p.grantedPermissions.filter((s) => drop.has(s));
                const next = patchPlugin(ctx, id, { grantedPermissions: p.grantedPermissions.filter((s) => !drop.has(s)) });
                await ctx.save();
                // Revoking what was not held changes nothing: no record.
                if (removed.length > 0) {
                    await audit(ctx, {
                        key: `${ctx.key}:${id}:revoked:${next.updatedAt}:${removed.join(',')}:${changed++}`,
                        kind: 'plugin.revoked',
                        at: next.updatedAt,
                        by: principalLabel(ctx.principal),
                        summary: `plugin ${id} revoked ${removed.join(', ')}`,
                        data: { pluginId: id, scopes: removed }
                    });
                }
                return view(ctx, next);
            },

            /** The effective mode of every tool the plugin declares or its connectors reported, name order (PLG-03). A read. */
            async toolPolicy(id: string): Promise<Record<string, ToolMode>> {
                return effectiveToolPolicy(ctx, plugin(ctx, id));
            },

            /**
             * Store the workspace-default mode of one of the plugin's tools (PLG-03). The tool must be one the manifest
             * declares or a connector of the plugin reported (`unknown-tool`). Recorded when the effective mode changes.
             */
            async setToolPolicy(id: string, tool: string, mode: ToolMode): Promise<Record<string, ToolMode>> {
                const p = plugin(ctx, id);
                if (!isToolMode(mode)) throw new TypeError(`[registry] a tool mode is allow, ask or deny (got ${JSON.stringify(mode)})`);
                const before = effectiveToolPolicy(ctx, p);
                if (typeof tool !== 'string' || !Object.hasOwn(before, tool)) throw new RegistryError('unknown-tool', `[registry] "${id}" has no tool ${JSON.stringify(tool)}`);
                const next = patchPlugin(ctx, id, { toolPolicy: { ...p.toolPolicy, [tool]: mode } });
                await ctx.save();
                if (before[tool] !== mode) {
                    await audit(ctx, {
                        key: `${ctx.key}:${id}:tool-policy:${next.updatedAt}:${tool}:${mode}:${changed++}`,
                        kind: 'plugin.tool-policy',
                        at: next.updatedAt,
                        by: principalLabel(ctx.principal),
                        summary: `plugin ${id} tool ${tool} set to ${mode}`,
                        data: { pluginId: id, tool, mode }
                    });
                }
                return effectiveToolPolicy(ctx, next);
            },

            async dependents(id: string): Promise<Dependents> {
                return dependents(ctx, id);
            },

            /** `dependents` for every plugin, id order, over ONE walk of the workspace — what the Plugins page reads. */
            async dependentsAll(): Promise<Dependents[]> {
                const refs = await collectRefs(ctx);
                return pluginIds(ctx).map((id) => dependentsOf(ctx, current(ctx, id)!, refs));
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
                if (input.transport === 'conduit') {
                    if (typeof input.connector !== 'string' || input.connector === '') throw new TypeError('[registry] a conduit connector needs a connector id');
                    // Ids only: its OAuth client is the connector plugin's secrets, its tokens the account's — never named on the record.
                    if (input.url !== undefined || input.command !== undefined || input.auth !== undefined || input.secrets !== undefined) throw new TypeError('[registry] a conduit connector has no url, command, secrets or auth');
                }
                for (const s of input.secrets ?? []) assertName(s, 'secret name');
                const bound = [input.auth?.bearer, ...Object.values(input.auth?.headers ?? {}), ...Object.values(input.auth?.env ?? {})].filter((s): s is string => s !== undefined);
                for (const s of bound) {
                    if (!(input.secrets ?? []).includes(s)) throw new TypeError(`[registry] connector "${input.id}" binds secret "${s}" without listing it in secrets`);
                }
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
                // Effective rows: a built-in nobody touched is still part of what the workspace runs on.
                for (const id of pluginIds(ctx)) rows.push({ kind: 'plugin', plugin: ctx.snapshot(current(ctx, id)!) });
                for (const id of Object.keys(ctx.state.connectors).sort()) rows.push({ kind: 'connector', connector: ctx.snapshot(ctx.state.connectors[id]!) });
                for (const name of Object.keys(ctx.state.secrets).sort()) rows.push({ kind: 'secret', secret: { name, updatedAt: ctx.state.secrets[name]!.updatedAt } });
                return rows;
            }
        })
    });
}

/** The Registry with no KEK and no catalogue: a hop target, and everything but secrets and built-ins. The app registers `defineRegistry({ kek, catalogue })`. */
export const Registry = defineRegistry();

export type RegistryActor = ReturnType<typeof defineRegistry>;
