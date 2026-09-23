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
 * secret is opened here. One the owner has not connected yet (no `account`)
 * is left out and the agent told so. A daemon-hosted session leaves conduit
 * connectors out until they are reachable from a machine (#534).
 */

import type { ConnectorCredentials, OpenSpecConnector } from '@agentic/core';
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
}

/** One connector for the app's opener, by the engine that opens it. */
export type ConnectorOpenInput = McpConnectorOpenInput | ConduitConnectorOpenInput;

export interface OpenedConnector {
    readonly tools: readonly ConnectorTool[];
    /** The names the session sees (`<id>__<tool>`). */
    readonly toolNames: readonly string[];
    close(): Promise<void>;
}

/** Opens one connector as tools, dispatching on `kind` — injected where the app is composed (`mcp` → `openMcpConnector` of `@agentic/mcp`). */
export type ConnectorOpener = (input: ConnectorOpenInput) => Promise<OpenedConnector>;

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

/** Why a connector the gate did not find ready is left out — the same words on both paths. */
function notReady(c: GateConnector): string | undefined {
    if (c.state === 'missing') return 'no such connector is set up in this workspace';
    if (c.state === 'disabled') return `its plugin is turned off (/plugins/${c.pluginId ?? c.id})`;
    return undefined;
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
        const opened = await input.opener({ kind: 'mcp', id: c.id, url: c.url, ...(bearer !== undefined ? { bearer } : {}), ...(Object.keys(headers).length ? { headers } : {}) });
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

/**
 * A ready conduit connector (#530): no secret is opened here — the opener resolves the OAuth client and the account's
 * tokens itself. Not connected yet (no `account`) → left out, and the agent told where the owner connects it.
 */
async function openConduit(c: GateConnector, input: OpenSessionConnectorsInput): Promise<Outcome> {
    const skip = (reason: string): Outcome => ({ unavailable: { id: c.id, reason } });
    const pluginId = c.pluginId ?? c.id;
    if (c.connector === undefined) return skip('it names no conduit connector');
    if (c.account === undefined) return skip(`it is not connected yet (/plugins/${pluginId})`);
    if (!input.opener) return skip('this deployment cannot open conduit connectors');
    const record = recorder(c, input);
    try {
        const opened = await input.opener({ kind: 'conduit', id: c.id, pluginId, connector: c.connector, account: c.account });
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
            unavailable.push({ id: c.id, reason: 'it runs on the platform and is not yet reachable from a machine session' });
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
    const c = input.connectors.find((x) => x.id === input.connectorId && x.state === 'ready');
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
