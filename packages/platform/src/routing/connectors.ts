/**
 * An agent's MCP connectors on a local session (#240, architecture §9;
 * AGT-02, AST-09, PLG-04). `Routing.run` asked the Registry about every
 * connector the agent names in the same `gate()` hop as its runtime; the
 * answer rides on `spec.plugins.connectors`. At open, each READY
 * Streamable HTTP connector is opened through the app's `ConnectorOpener`
 * (`openMcpConnector` of `@agentic/mcp`, wired where the app is composed)
 * with its credentials opened from the Registry under the connector
 * plugin's own `secret:` grants, and its tools join the session namespaced
 * `<id>__<tool>`. Nothing about a connector fails the session: one that is
 * missing, turned off, machine-side (stdio), without a secret or unreachable
 * is left out, the agent is told which and why (`unavailable`, rendered in
 * its system prompt), and a change in what an open found is recorded with
 * `Registry.setConnectorStatus`.
 *
 * Approval: a connector tool is asked about like any tool — the agent's
 * `approvalPolicy` rules first, then its `tools[]` grant by the namespaced
 * name (`allow` / `ask` / `deny`), then allowed. So that category rules
 * reach it, a connector tool's request is presented as `source: 'mcp'` with
 * a category from its MCP hints (`connectorCategory`): `destructiveHint` →
 * `destructive`, `readOnlyHint` → `read`, anything else → `network`.
 *
 * On a DAEMON-hosted session (#280) the daemon opens them instead:
 * `daemonConnectors` puts the ready ones on `OpenSpec.connectors` with secret
 * NAMES only (the Machine keeps the spec), and the daemon asks for the values
 * over its own `tool.call` (`CONNECTOR_CREDENTIALS_TOOL`), answered by
 * `connectorCredentials` for a connector the calling session's gate names.
 *
 * A CONDUIT connector (#530, decisions 2026-09-23) goes to the same opener as
 * `{ kind: 'conduit', id, pluginId, connector, account }` — ids only: the
 * opener resolves the OAuth client and the account's tokens itself, so no
 * secret is opened here. One that the owner has not connected yet (no `account`)
 * is left out and the agent told so. The opener gets the session's
 * `ConnectorOpenContext` beside the ids (#533) — the workspace, the session's
 * agent principal and the way to the connector plugin's secrets — so the app
 * builds the workspace's conduit engine itself.
 *
 * On a DAEMON-hosted session a conduit connector still runs here, on the Worker
 * (#534): `daemonConnectors` puts nothing of it on the spec; the daemon asks for
 * its tool declarations over its own `tool.call` (`CONNECTOR_TOOLS_TOOL`,
 * answered by `platformConnectorTools`) and sends every call back the same way
 * (`CONNECTOR_CALL_TOOL`, run by `callPlatformConnector`) — through the same
 * opener and context as a local session, so refresh and `needsReauth` behave
 * the same and no token or OAuth client ever reaches the machine.
 *
 * `network:` grants (#642; PLG-04): every connector the platform opens gets its plugin's granted `network:` hosts as
 * `allowedHosts` (from the gate's `networkHosts`), and the opener runs its fetch behind that allowlist (`guardFetch` of
 * `@agentic/mcp`, `guardHttp` of `@agentic/connectors`): a request to any other host fails with an error that names
 * the scope. A Streamable HTTP connector whose own host is not granted is not opened at all — nor placed on a
 * daemon's spec, nor given credentials — and the agent is told why. A stdio server is out of reach: it is a process
 * on a machine, and the platform cannot see what it connects to.
 */

import type { ApprovalRule, ConnectorCredentials, ConnectorToolDeclaration, OpenSpecConnector, PlatformConnectorTools, Principal, WorkspaceId } from '@agentic/core';
import type { PlatformAgentDeps } from '@agentic/runtimes';
import type { Policy, ToolAnnotations } from '@sigx/ai-agent';
import type { ConnectorStatus, GateConnector } from '../registry/types.js';

/** A tool as the model agent takes it (`@sigx/ai`'s `AnyTool`). */
export type ConnectorTool = NonNullable<PlatformAgentDeps['tools']>[number];

/** What the app's opener is handed for one Streamable HTTP MCP connector: credential VALUES, opened for this session only. */
export interface McpConnectorOpenInput {
    readonly kind: 'mcp';
    readonly id: string;
    readonly url: string;
    readonly bearer?: string;
    readonly headers?: Readonly<Record<string, string>>;
    /** The hosts of the plugin's granted `network:` scopes (#642): the opener's fetch reaches these only. Absent: no allowlist. */
    readonly allowedHosts?: readonly string[];
}

/** What the app's opener is handed for one conduit connector: ids only — the opener resolves the OAuth client and the account's tokens itself. */
export interface ConduitConnectorOpenInput {
    readonly kind: 'conduit';
    readonly id: string;
    /** The connector plugin, whose `secret:` grants cover its OAuth client. */
    readonly pluginId: string;
    /** The conduit connector id (`gmail`). */
    readonly connector: string;
    /** The conduit account id the owner connected. */
    readonly account: string;
    /** The hosts of the plugin's granted `network:` scopes (#642): the engine's fetch reaches these only. Absent: no allowlist. */
    readonly allowedHosts?: readonly string[];
}

/** One connector for the app's opener, by the engine that opens it. */
export type ConnectorOpenInput = McpConnectorOpenInput | ConduitConnectorOpenInput;

export interface OpenedConnector {
    readonly tools: readonly ConnectorTool[];
    /** The names the session sees (`<id>__<tool>`). */
    readonly toolNames: readonly string[];
    close(): Promise<void>;
}

/**
 * Who a session opens its connectors for (#533): what a conduit opener needs to reach the workspace's accounts and
 * the connector plugin's secrets itself. An MCP opener ignores it.
 */
export interface ConnectorOpenContext {
    readonly workspaceId: WorkspaceId;
    /** The session's own agent principal: tool calls (and the token refreshes inside them) run under it. */
    readonly principal: Principal;
    /** A secret of a connector plugin, through `Registry.openSecret(name, pluginId)` (enabled + granted, audited); `undefined` when not set. */
    secret(name: string, pluginId: string): Promise<string | undefined>;
}

/**
 * Opens one connector as tools, dispatching on `kind` — injected where the app is composed (`mcp` → `openMcpConnector`
 * of `@agentic/mcp`, `conduit` → `conduitTools` over the workspace's engine). `context` is the session's, when the
 * caller has one (`anthropicApiRuntime` always does).
 */
export type ConnectorOpener = (input: ConnectorOpenInput, context?: ConnectorOpenContext) => Promise<OpenedConnector>;

/** A connector the agent names that this session runs without, and why — told to the agent. */
export interface UnavailableConnector {
    readonly id: string;
    readonly reason: string;
}

export interface SessionConnectors {
    readonly tools: readonly ConnectorTool[];
    readonly unavailable: readonly UnavailableConnector[];
    /** Every connector tool's hints, by name — what `connectorPolicy` presents to the rules. */
    readonly annotations: ReadonlyMap<string, ToolAnnotations | undefined>;
    /** Closes every opened connector; never throws. */
    close(): Promise<void>;
}

export interface OpenSessionConnectorsInput {
    /** The gate's answer for the agent's connectors (`spec.plugins.connectors`). */
    readonly connectors: readonly GateConnector[];
    readonly opener?: ConnectorOpener;
    /** A secret of the connector's plugin, through `Registry.openSecret(name, pluginId)`; `undefined` when not set. */
    secret(name: string, pluginId: string): Promise<string | undefined>;
    /** Record what an open found — called only when it differs from what the Registry last had. A failure to record never fails the open. */
    report?(id: string, status: ConnectorStatus, tools?: readonly string[]): Promise<void>;
    /** Tool names already on the session (the platform's); a connector tool may not shadow one. */
    readonly taken?: readonly string[];
    /** Handed to the opener as its second argument (#533). */
    readonly context?: ConnectorOpenContext;
}

/** The category a connector tool's request is ruled on. */
export function connectorCategory(annotations: ToolAnnotations | undefined): 'destructive' | 'read' | 'network' {
    if (annotations?.destructive) return 'destructive';
    if (annotations?.readOnly) return 'read';
    return 'network';
}

/** `policy`, with a connector tool's request presented as `source: 'mcp'` and its category — so the agent's category rules apply to it. */
export function connectorPolicy(policy: Policy, annotations: ReadonlyMap<string, ToolAnnotations | undefined>): Policy {
    if (annotations.size === 0) return policy;
    const wrapped: Policy = (request, context) => {
        if (request.kind !== 'permission' || request.toolName === undefined || !annotations.has(request.toolName)) return policy(request, context);
        const hints = annotations.get(request.toolName);
        return policy({ ...request, source: 'mcp', category: request.category ?? connectorCategory(hints ?? request.annotations) }, context);
    };
    return Object.assign(wrapped, { id: policy.id ?? 'connectors' });
}

/** An error's message with every credential value in it blanked — a server may echo a header back. */
function scrub(message: string, values: readonly string[]): string {
    let out = message;
    for (const v of values) if (v.length >= 4) out = out.split(v).join('***');
    return out;
}

const sameTools = (a: readonly string[] | undefined, b: readonly string[]): boolean => a !== undefined && a.length === b.length && a.every((n, i) => n === b[i]);

interface Outcome {
    readonly opened?: OpenedConnector;
    readonly unavailable?: UnavailableConnector;
}

/** Why a revoked `tools:` grant leaves a connector out (#636; PLG-04) — on both paths. */
export const TOOLS_REVOKED_REASON = 'tools permission revoked';

/** Whether `url` is on `hosts` — by host (with its port) or by hostname, as a `network:<url.host>` scope names it. */
function networkHostAllowed(hosts: readonly string[], url: URL): boolean {
    return hosts.includes(url.host) || hosts.includes(url.hostname);
}

/**
 * Why a Streamable HTTP connector may not reach its own server (#642; PLG-04): its plugin's `network:<host>` scope is
 * not granted. Names the scope and the plugin page — never the URL's path or query. `undefined` when it may, when it is not an HTTP
 * one, or when the gate answer predates the allowlist.
 */
function networkRevoked(c: GateConnector): string | undefined {
    if (c.networkHosts === undefined || c.url === undefined || (c.transport ?? 'streamable-http') !== 'streamable-http') return undefined;
    let url: URL;
    try {
        url = new URL(c.url);
    } catch {
        return undefined;
    }
    return networkHostAllowed(c.networkHosts, url) ? undefined : `network permission revoked: network:${url.host} is not granted (/plugins/${c.pluginId ?? c.id})`;
}

/** Why a connector the gate did not find usable is left out — the same words on both paths. */
function notReady(c: GateConnector): string | undefined {
    if (c.state === 'missing') return 'no such connector is set up in this workspace';
    if (c.state === 'disabled') return `its plugin is turned off (/plugins/${c.pluginId ?? c.id})`;
    if (c.toolsGranted === false) return TOOLS_REVOKED_REASON;
    return networkRevoked(c);
}

/** Ready, with its plugin's `tools:` scope still granted and its server's `network:` host too: a connector a session may reach (#636, #642). */
const usable = (c: GateConnector): boolean => c.state === 'ready' && c.toolsGranted !== false && networkRevoked(c) === undefined;

/** The opener's `allowedHosts`, when the gate answer carries them (#642) — a plain copy: it may be read out of actor state. */
const allowedHostsOf = (c: GateConnector): { allowedHosts?: readonly string[] } => (c.networkHosts !== undefined ? { allowedHosts: [...c.networkHosts] } : {});

/**
 * The workspace tool policy of the agent's connectors as approval constraints (#636; OPS-02, AC-12): one rule per
 * ask / deny tool name across the usable connectors, `workspace:<plugin>:<tool>` (the stricter outcome on a name clash). Constraints only tighten — the stricter of
 * the agent's answer and the workspace's wins — so a workspace `deny` beats an agent `allow`, and a workspace `ask`
 * never loosens an agent `deny`.
 */
export function workspaceToolRules(connectors: readonly GateConnector[]): ApprovalRule[] {
    // One rule per tool name: two connectors can collide on a name, and first-match would make that order-dependent,
    // so the stricter outcome wins (deny over ask) — constraints only tighten.
    const byTool = new Map<string, ApprovalRule>();
    for (const c of connectors) {
        if (!usable(c)) continue;
        const plugin = c.pluginId ?? c.id;
        for (const [tool, outcome] of Object.entries(c.toolPolicy ?? {})) {
            if (outcome !== 'ask' && outcome !== 'deny') continue;
            const prior = byTool.get(tool);
            if (prior && (prior.outcome === 'deny' || outcome === 'ask')) continue;
            byTool.set(tool, { id: `workspace:${plugin}:${tool}`, match: { tools: [tool] }, outcome });
        }
    }
    return [...byTool.values()];
}

/** Records what an open found — only when it differs from what the gate answer says the Registry has; never throws. */
function recorder(c: GateConnector, input: OpenSessionConnectorsInput): (status: ConnectorStatus, tools?: readonly string[]) => Promise<void> {
    return async (status, tools) => {
        const unchanged = c.status?.state === status.state && (status.state !== 'error' || c.status.error === status.error) && (tools === undefined || sameTools(c.tools, tools));
        if (unchanged || !input.report) return;
        await input.report(c.id, status, tools).catch((e: unknown) => console.warn(`[routing] connector ${c.id}: status not recorded:`, e));
    };
}

async function openOne(c: GateConnector, input: OpenSessionConnectorsInput): Promise<Outcome> {
    const skip = (reason: string): Outcome => ({ unavailable: { id: c.id, reason } });
    const why = notReady(c);
    if (why !== undefined) return skip(why);
    if (c.transport === 'conduit') return openConduit(c, input);
    if (c.transport !== 'streamable-http') return skip('it runs on a machine over stdio; only an agent whose sessions run on a machine can use it');
    if (!input.opener) return skip('this deployment cannot open MCP connectors');
    if (c.url === undefined) return skip('it has no URL');
    const pluginId = c.pluginId ?? c.id;
    const values: string[] = [];
    const record = recorder(c, input);
    try {
        const need = async (name: string): Promise<string> => {
            const value = await input.secret(name, pluginId);
            if (value === undefined) throw Object.assign(new Error(`its secret "${name}" is not set (/plugins/${pluginId})`), { unset: true });
            values.push(value);
            return value;
        };
        const bearer = c.auth?.bearer !== undefined ? await need(c.auth.bearer) : undefined;
        const headers: Record<string, string> = {};
        for (const [header, name] of Object.entries(c.auth?.headers ?? {})) headers[header] = await need(name);
        const opened = await input.opener({ kind: 'mcp', id: c.id, url: c.url, ...(bearer !== undefined ? { bearer } : {}), ...(Object.keys(headers).length ? { headers } : {}), ...allowedHostsOf(c) }, input.context);
        await record({ state: 'ok' }, opened.toolNames);
        return { opened };
    } catch (e) {
        const message = scrub(e instanceof Error ? e.message : String(e), values);
        const unset = (e as { unset?: boolean }).unset === true;
        // A secret not set is recorded too, so the plugin page shows why the connector does nothing.
        await record({ state: 'error', error: unset ? `secret not set: ${message}` : message });
        return skip(unset ? message : `it could not be reached: ${message}`);
    }
}

/** Why a ready conduit connector cannot be used yet — the same words on both paths; `undefined` once it is connected. */
function conduitUnconnected(c: GateConnector): string | undefined {
    if (c.connector === undefined) return 'it names no conduit connector';
    if (c.account === undefined) return `it is not connected yet (/plugins/${c.pluginId ?? c.id})`;
    return undefined;
}

/**
 * A ready conduit connector (#530): no secret is opened here — the opener resolves the OAuth client and the account's
 * tokens itself. Not connected yet (no `account`) → left out, and the agent told where the owner connects it.
 */
async function openConduit(c: GateConnector, input: OpenSessionConnectorsInput): Promise<Outcome> {
    const skip = (reason: string): Outcome => ({ unavailable: { id: c.id, reason } });
    const pluginId = c.pluginId ?? c.id;
    const why = conduitUnconnected(c);
    if (why !== undefined || c.connector === undefined || c.account === undefined) return skip(why ?? 'it names no conduit connector');
    if (!input.opener) return skip('this deployment cannot open conduit connectors');
    const record = recorder(c, input);
    try {
        const opened = await input.opener({ kind: 'conduit', id: c.id, pluginId, connector: c.connector, account: c.account, ...allowedHostsOf(c) }, input.context);
        await record({ state: 'ok' }, opened.toolNames);
        return { opened };
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        await record({ state: 'error', error: message });
        return skip(`it could not be opened: ${message}`);
    }
}

/**
 * Open every ready connector side by side; none can fail the caller. A tool
 * name already taken — by the platform's tools or an earlier connector whose
 * id sanitises to the same namespace — leaves that connector out.
 */
export async function openSessionConnectors(input: OpenSessionConnectorsInput): Promise<SessionConnectors> {
    const outcomes = await Promise.all(input.connectors.map((c) => openOne(c, input)));
    const taken = new Set(input.taken ?? []);
    const tools: ConnectorTool[] = [];
    const annotations = new Map<string, ToolAnnotations | undefined>();
    const unavailable: UnavailableConnector[] = [];
    const opened: OpenedConnector[] = [];
    for (const [i, o] of outcomes.entries()) {
        if (o.unavailable) unavailable.push(o.unavailable);
        if (!o.opened) continue;
        const clash = o.opened.tools.find((t) => taken.has(t.name));
        if (clash) {
            unavailable.push({ id: input.connectors[i]!.id, reason: `its tool "${clash.name}" has the name of a tool this session already has` });
            await o.opened.close().catch(() => undefined);
            continue;
        }
        opened.push(o.opened);
        for (const t of o.opened.tools) {
            taken.add(t.name);
            tools.push(t);
            annotations.set(t.name, t.annotations);
        }
    }
    return {
        tools,
        unavailable,
        annotations,
        async close() {
            await Promise.all(opened.map((o) => o.close().catch(() => undefined)));
        }
    };
}

/**
 * The approval constraints a session opens under (#636; AC-12): the ancestors' (`route.constraints`, a delegated
 * task's chain) with the workspace's rules (`workspaceToolRules`) in front, so that ONE first-match set gives the
 * stricter of the two answers for every request — what `OpenSpecPolicy.constraints` carries, with no protocol change.
 * Plain concatenation would not: the ancestors' set holds the parent agents' own rules, `allow` ones included, and
 * behind a parent's `allow gmail__send-email` a workspace `deny` would never be reached; in front of a parent's
 * `deny`, a workspace `ask` would hide it. So each workspace rule leads a block scoped to its one tool: a `deny` is the
 * block (nothing is stricter); an `ask` is preceded by every ancestor rule that could match that tool, narrowed to it
 * and with its outcome raised to at least `ask` (an ancestor `deny` keeps its id and wins, anything else asks under the
 * workspace's id). A request for that tool always stops in its block; any other request falls through to the
 * ancestors' rules unchanged.
 */
export function withWorkspaceRules(ancestors: readonly ApprovalRule[], workspace: readonly ApprovalRule[]): ApprovalRule[] {
    const out: ApprovalRule[] = [];
    for (const w of workspace) {
        const tool = w.match.tools?.length === 1 ? w.match.tools[0] : undefined;
        if (w.outcome !== 'ask' || tool === undefined) {
            out.push(w);
            continue;
        }
        for (const a of ancestors) {
            if (a.match.tools && !a.match.tools.includes(tool)) continue;
            const deny = a.outcome === 'deny';
            out.push({ ...a, id: deny ? a.id : w.id, match: { ...a.match, tools: [tool] }, outcome: deny ? 'deny' : 'ask' });
        }
        out.push(w);
    }
    return [...out, ...ancestors];
}

/** A plain copy of a gate answer's `auth` — it may be read out of actor state, which does not clone. */
function plainAuth(auth: NonNullable<GateConnector['auth']>): NonNullable<OpenSpecConnector['auth']> {
    return {
        ...(auth.bearer !== undefined ? { bearer: auth.bearer } : {}),
        ...(auth.headers ? { headers: { ...auth.headers } } : {}),
        ...(auth.env ? { env: { ...auth.env } } : {})
    };
}

export interface DaemonConnectorPlacement {
    /** The ready connectors, as the daemon opens them — secret NAMES only. */
    readonly connectors: readonly OpenSpecConnector[];
    /** The rest, and why — for the session's system prompt. */
    readonly unavailable: readonly UnavailableConnector[];
}

/**
 * The agent's connectors for a session on machine `machineId` (#280): every ready one goes on the spec for the daemon
 * to open, except a stdio server set up for another machine. Nothing here opens a secret — the spec is kept by the
 * Machine and re-sent after a reconnect, so it never holds a credential.
 */
export function daemonConnectors(connectors: readonly GateConnector[], machineId: string): DaemonConnectorPlacement {
    const placed: OpenSpecConnector[] = [];
    const unavailable: UnavailableConnector[] = [];
    for (const c of connectors) {
        const why = notReady(c);
        if (why !== undefined) {
            unavailable.push({ id: c.id, reason: why });
            continue;
        }
        if (c.transport === 'conduit') {
            // Runs on the Worker (#534): nothing on the spec — the daemon asks for its declarations over `tool.call`.
            const why = conduitUnconnected(c);
            if (why !== undefined) unavailable.push({ id: c.id, reason: why });
            continue;
        }
        const transport = c.transport ?? 'streamable-http';
        // `*` (or none): any paired machine may run it.
        if (transport === 'stdio' && c.machine !== undefined && c.machine !== '*' && c.machine !== machineId) {
            unavailable.push({ id: c.id, reason: `it runs on machine ${c.machine}, not the one this session runs on` });
            continue;
        }
        placed.push({
            id: c.id,
            transport,
            ...(c.url !== undefined ? { url: c.url } : {}),
            ...(c.command !== undefined ? { command: c.command } : {}),
            ...(c.args !== undefined ? { args: [...c.args] } : {}),
            ...(c.cwd !== undefined ? { cwd: c.cwd } : {}),
            ...(c.auth ? { auth: plainAuth(c.auth) } : {})
        });
    }
    return { connectors: placed, unavailable };
}

/** Why `connectorCredentials` refused: the connector is not the session's to open, or a secret it needs is not set. */
export class ConnectorCredentialsError extends Error {
    constructor(
        readonly code: 'not-named' | 'secret-unset',
        message: string
    ) {
        super(message);
        this.name = 'ConnectorCredentialsError';
    }
}

export interface ConnectorCredentialsInput {
    /** The calling session's gate answer (`spec.plugins.connectors`): only a ready connector named there is answered. */
    readonly connectors: readonly GateConnector[];
    readonly connectorId: string;
    /** A secret of the connector's plugin, through `Registry.openSecret(name, pluginId)`; `undefined` when not set. */
    secret(name: string, pluginId: string): Promise<string | undefined>;
    /** Record a secret that is not set on the connector — only when the Registry does not already say so. Never fails the call. */
    report?(id: string, status: ConnectorStatus): Promise<void>;
}

/**
 * A connector's credential VALUES for the daemon that opens it (#280; EXE-10): each secret its `auth` names, opened
 * under the connector plugin's own `secret:` grants (audited by the Registry). Returned, never recorded.
 */
export async function connectorCredentials(input: ConnectorCredentialsInput): Promise<ConnectorCredentials> {
    const c = input.connectors.find((x) => x.id === input.connectorId && usable(x));
    if (!c) throw new ConnectorCredentialsError('not-named', `connector "${input.connectorId}" is not one this session may open`);
    const pluginId = c.pluginId ?? c.id;
    const need = async (name: string): Promise<string> => {
        const value = await input.secret(name, pluginId);
        if (value !== undefined) return value;
        const message = `its secret "${name}" is not set (/plugins/${pluginId})`;
        const error = `secret not set: ${message}`;
        if (input.report && !(c.status?.state === 'error' && c.status.error === error)) {
            await input.report(c.id, { state: 'error', error }).catch((e: unknown) => console.warn(`[routing] connector ${c.id}: status not recorded:`, e));
        }
        throw new ConnectorCredentialsError('secret-unset', message);
    };
    const bearer = c.auth?.bearer !== undefined ? await need(c.auth.bearer) : undefined;
    const headers: Record<string, string> = {};
    for (const [header, name] of Object.entries(c.auth?.headers ?? {})) headers[header] = await need(name);
    const env: Record<string, string> = {};
    for (const [variable, name] of Object.entries(c.auth?.env ?? {})) env[variable] = await need(name);
    return { ...(bearer !== undefined ? { bearer } : {}), ...(Object.keys(headers).length ? { headers } : {}), ...(Object.keys(env).length ? { env } : {}) };
}

/** A connector a daemon-hosted session reaches on the platform (#534): a ready conduit connector the owner connected. */
const platformRun = (c: GateConnector): boolean => usable(c) && c.transport === 'conduit' && conduitUnconnected(c) === undefined;

export interface PlatformConnectorToolsInput {
    /** The calling session's gate answer (`spec.plugins.connectors`). */
    readonly connectors: readonly GateConnector[];
    readonly opener?: ConnectorOpener;
    /** The session's: its workspace, its agent principal and the connector plugins' secrets. */
    readonly context: ConnectorOpenContext;
    /** Record what an open found, as a local session's open does. Never fails the call. */
    report?(id: string, status: ConnectorStatus, tools?: readonly string[]): Promise<void>;
}

/** A tool's hints as plain JSON — what the daemon's approval rules on. */
function plainAnnotations(a: ToolAnnotations | undefined): ConnectorToolDeclaration['annotations'] {
    if (!a) return undefined;
    const out: { -readonly [K in keyof ToolAnnotations]: ToolAnnotations[K] } = {};
    if (a.readOnly !== undefined) out.readOnly = a.readOnly;
    if (a.destructive !== undefined) out.destructive = a.destructive;
    if (a.idempotent !== undefined) out.idempotent = a.idempotent;
    if (a.openWorld !== undefined) out.openWorld = a.openWorld;
    return Object.keys(out).length ? out : undefined;
}

/** What the model sees of a tool, and its hints — never how it runs. */
function declarationOf(t: ConnectorTool): ConnectorToolDeclaration {
    const annotations = plainAnnotations(t.annotations);
    // A tool's arguments are an object (conduit's input schemas always are): the declaration says so explicitly.
    const inputSchema = { ...(structuredClone(t.spec.inputSchema) as Record<string, unknown>), type: 'object' as const };
    return { name: t.spec.name, description: t.spec.description, inputSchema, ...(annotations ? { annotations } : {}) };
}

/**
 * The answer to a daemon's `CONNECTOR_TOOLS_TOOL` (#534): every ready, connected conduit connector of the calling
 * session, opened through the app's opener as a local session opens it, as tool DECLARATIONS — the engine, its
 * tokens and the OAuth client stay here. One that cannot be opened is named with why, as on the local path.
 */
export async function platformConnectorTools(input: PlatformConnectorToolsInput): Promise<PlatformConnectorTools> {
    const conduit = input.connectors.filter(platformRun);
    const open: OpenSessionConnectorsInput = {
        connectors: conduit,
        ...(input.opener ? { opener: input.opener } : {}),
        secret: (name, pluginId) => input.context.secret(name, pluginId),
        ...(input.report ? { report: input.report } : {}),
        context: input.context
    };
    const outcomes = await Promise.all(conduit.map(async (c) => ({ id: c.id, outcome: await openConduit(c, open) })));
    const connectors: { id: string; tools: ConnectorToolDeclaration[] }[] = [];
    const unavailable: UnavailableConnector[] = [];
    for (const { id, outcome } of outcomes) {
        if (outcome.unavailable) unavailable.push(outcome.unavailable);
        if (!outcome.opened) continue;
        try {
            connectors.push({ id, tools: outcome.opened.tools.map(declarationOf) });
        } finally {
            await outcome.opened.close().catch(() => undefined);
        }
    }
    return { connectors, unavailable };
}

/** Why `callPlatformConnector` refused or failed. `not-named` is the session's to fix, never the connector's. */
export class PlatformConnectorError extends Error {
    constructor(
        /** `not-named`, `unsupported`, `invalid`, or the tool's own (`needs_reauth`, conduit's codes), else `internal`. */
        readonly code: string,
        message: string
    ) {
        super(message);
        this.name = 'PlatformConnectorError';
    }
}

export interface CallPlatformConnectorInput extends Omit<PlatformConnectorToolsInput, 'report'> {
    readonly connectorId: string;
    /** The tool's namespaced name (`gmail__search-messages`). */
    readonly tool: string;
    readonly input: unknown;
    readonly callId: string;
    readonly signal?: AbortSignal;
}

/**
 * A daemon's `CONNECTOR_CALL_TOOL` (#534): one operation of a conduit connector the calling session's gate names as
 * ready and connected, run here under the session's agent principal (a refresh inside it writes as the session). The
 * result goes back to the machine; a failure is a message the agent may read, with every secret opened for it blanked.
 */
export async function callPlatformConnector(input: CallPlatformConnectorInput): Promise<unknown> {
    const c = input.connectors.find((x) => x.id === input.connectorId && usable(x) && x.transport === 'conduit');
    if (!c) throw new PlatformConnectorError('not-named', `connector "${input.connectorId}" is not one this session may use on the platform`);
    const why = conduitUnconnected(c);
    if (why !== undefined || c.connector === undefined || c.account === undefined) throw new PlatformConnectorError('unsupported', `connector "${c.id}": ${why ?? 'it names no conduit connector'}`);
    if (!input.opener) throw new PlatformConnectorError('unsupported', 'this deployment cannot open conduit connectors');
    const values: string[] = [];
    const context: ConnectorOpenContext = {
        workspaceId: input.context.workspaceId,
        principal: input.context.principal,
        async secret(name, pluginId) {
            const value = await input.context.secret(name, pluginId);
            if (value !== undefined) values.push(value);
            return value;
        }
    };
    const failed = (e: unknown): PlatformConnectorError => {
        if (e instanceof PlatformConnectorError) return e;
        const message = scrub(e instanceof Error ? e.message : String(e), values);
        const name = e instanceof Error ? e.name : '';
        const code = (e as { code?: unknown } | null)?.code;
        if (name === 'SchemaValidationError') return new PlatformConnectorError('invalid', message);
        // `ConnectorToolError` (`@agentic/connectors`): a message written for the agent, and a stable code (`needs_reauth`).
        if (name === 'ConnectorToolError' && typeof code === 'string' && code !== '') return new PlatformConnectorError(code, message);
        return new PlatformConnectorError('internal', `${input.tool} failed: ${message}`);
    };
    let opened: OpenedConnector;
    try {
        opened = await input.opener({ kind: 'conduit', id: c.id, pluginId: c.pluginId ?? c.id, connector: c.connector, account: c.account, ...allowedHostsOf(c) }, context);
    } catch (e) {
        throw failed(e);
    }
    try {
        const tool = opened.tools.find((t) => t.name === input.tool);
        if (!tool) throw new PlatformConnectorError('invalid', `connector "${c.id}" has no tool named "${input.tool}"`);
        return await tool.run(input.input, { toolCallId: input.callId, signal: input.signal ?? new AbortController().signal });
    } catch (e) {
        throw failed(e);
    } finally {
        await opened.close().catch(() => undefined);
    }
}
