/**
 * An agent's MCP connectors on a daemon-hosted harness session (#280,
 * architecture §9) — the daemon side of what `openSessionConnectors` does for a
 * local session (#240). The platform puts the agent's READY connectors on
 * `OpenSpec.connectors` with secret NAMES only; here each one is opened for this
 * session:
 *
 * - its credential VALUES come from the platform over the daemon's own
 *   `tool.call` (`CONNECTOR_CREDENTIALS_TOOL`), are handed to the opener and
 *   are otherwise kept nowhere — not in the spec, a log line or a file (EXE-10);
 * - a stdio server runs in the connector's `cwd` (the session's `cwd` when it
 *   names none), which must lie inside the environment's `cwdRoots`, with the
 *   stdio client's allowlisted environment plus its credential variables;
 * - its tools join the session's client tools, served over the harness's tool
 *   server like the platform's, named `<id>__<tool>`, and it is closed with
 *   the session.
 *
 * Nothing about a connector fails the session: one that cannot be opened is
 * left out and named, with why, in the system prompt and the capability report.
 *
 * Approval: the daemon compiles the same policy the platform does (AC-12); a
 * connector tool's request is presented to it as `source: 'mcp'` with a
 * category from its MCP hints, as `connectorPolicy` does on the local path.
 */

import type { AnyTool } from '@sigx/ai';
import type { Policy, ToolAnnotations } from '@sigx/ai-agent';
import { isWithin } from '@sigx/ai-agent/coding';
import { CONNECTOR_CREDENTIALS_TOOL, type ConnectorCredentials, type LocalEnvironment, type OpenSpecConnector, type PlatformToolCaller } from '@agentic/core';

/** What the daemon's opener is handed for one connector: where it is, and its credential VALUES for this session only. */
export interface DaemonConnectorOpenInput {
    readonly id: string;
    readonly transport: 'streamable-http' | 'stdio';
    readonly url?: string;
    readonly command?: string;
    readonly args?: readonly string[];
    /** Stdio: resolved, and inside the environment's roots. */
    readonly cwd?: string;
    readonly bearer?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly env?: Readonly<Record<string, string>>;
}

export interface DaemonOpenedConnector {
    /** Namespaced `<id>__<tool>` by the opener. */
    readonly tools: readonly AnyTool[];
    close(): Promise<void>;
}

/** Opens one connector as tools — `@agentic/mcp`'s openers, injected by the daemon. */
export type DaemonConnectorOpener = (input: DaemonConnectorOpenInput) => Promise<DaemonOpenedConnector>;

export interface UnavailableDaemonConnector {
    readonly id: string;
    readonly reason: string;
}

export interface DaemonConnectors {
    readonly tools: readonly AnyTool[];
    readonly unavailable: readonly UnavailableDaemonConnector[];
    /** Every connector tool's hints, by name — what `withConnectorPolicy` presents to the rules. */
    readonly annotations: ReadonlyMap<string, ToolAnnotations | undefined>;
    /** Closes every opened connector; never throws. */
    close(): Promise<void>;
}

export interface OpenDaemonConnectorsInput {
    readonly connectors: readonly OpenSpecConnector[];
    readonly env: LocalEnvironment;
    /** The session's folder — a stdio connector's default `cwd`. */
    readonly cwd: string;
    readonly callTool: PlatformToolCaller;
    readonly opener?: DaemonConnectorOpener;
    /** Tool names already on the session (the platform's); a connector tool may not shadow one. */
    readonly taken?: readonly string[];
}

/** The category a connector tool's request is ruled on — the same mapping as the platform's `connectorCategory`. */
export function connectorCategory(annotations: ToolAnnotations | undefined): 'destructive' | 'read' | 'network' {
    if (annotations?.destructive) return 'destructive';
    if (annotations?.readOnly) return 'read';
    return 'network';
}

/** `policy`, with a connector tool's request presented as `source: 'mcp'` and its category — so the agent's category rules apply to it. */
export function withConnectorPolicy<P extends Policy | undefined>(policy: P, annotations: ReadonlyMap<string, ToolAnnotations | undefined>): P {
    if (policy === undefined || annotations.size === 0) return policy;
    const inner: Policy = policy;
    const wrapped: Policy = (request, context) => {
        if (request.kind !== 'permission' || request.toolName === undefined || !annotations.has(request.toolName)) return inner(request, context);
        const hints = annotations.get(request.toolName);
        return inner({ ...request, source: 'mcp', category: request.category ?? connectorCategory(hints ?? request.annotations) }, context);
    };
    return Object.assign(wrapped, { id: inner.id ?? 'connectors' }) as P;
}

/** An error's message with every credential value in it blanked — a server may echo a header back, a process its environment. */
function scrub(message: string, values: readonly string[]): string {
    let out = message;
    for (const v of values) if (v.length >= 4) out = out.split(v).join('***');
    return out;
}

const hasNames = (c: OpenSpecConnector): boolean => c.auth !== undefined && (c.auth.bearer !== undefined || Object.keys(c.auth.headers ?? {}).length > 0 || Object.keys(c.auth.env ?? {}).length > 0);

const stringRecord = (v: unknown): Record<string, string> | undefined => {
    if (typeof v !== 'object' || v === null) return undefined;
    const out: Record<string, string> = {};
    for (const [k, x] of Object.entries(v)) if (typeof x === 'string') out[k] = x;
    return out;
};

interface Outcome {
    readonly opened?: DaemonOpenedConnector;
    readonly unavailable?: UnavailableDaemonConnector;
}

async function openOne(c: OpenSpecConnector, input: OpenDaemonConnectorsInput): Promise<Outcome> {
    const skip = (reason: string): Outcome => ({ unavailable: { id: c.id, reason } });
    if (!input.opener) return skip('this machine cannot open MCP connectors');
    if (c.transport === 'streamable-http' && c.url === undefined) return skip('it has no URL');
    if (c.transport === 'stdio' && c.command === undefined) return skip('it has no command to run');
    const cwd = c.transport === 'stdio' ? (c.cwd ?? input.cwd) : undefined;
    if (cwd !== undefined && !input.env.cwdRoots.some((root) => isWithin(cwd, root))) return skip(`its folder ${cwd} is outside the folders of environment "${input.env.name}"`);
    const values: string[] = [];
    try {
        let credentials: ConnectorCredentials = {};
        if (hasNames(c)) {
            const answer = (await input.callTool(CONNECTOR_CREDENTIALS_TOOL, { connectorId: c.id })) as Partial<ConnectorCredentials> | null;
            const headers = stringRecord(answer?.headers);
            const env = stringRecord(answer?.env);
            credentials = { ...(typeof answer?.bearer === 'string' ? { bearer: answer.bearer } : {}), ...(headers ? { headers } : {}), ...(env ? { env } : {}) };
            if (credentials.bearer !== undefined) values.push(credentials.bearer);
            values.push(...Object.values(credentials.headers ?? {}), ...Object.values(credentials.env ?? {}));
        }
        const opened = await input.opener({
            id: c.id,
            transport: c.transport,
            ...(c.url !== undefined ? { url: c.url } : {}),
            ...(c.command !== undefined ? { command: c.command } : {}),
            ...(c.args !== undefined ? { args: c.args } : {}),
            ...(cwd !== undefined ? { cwd } : {}),
            ...credentials
        });
        return { opened };
    } catch (e) {
        return skip(`it could not be opened: ${scrub(e instanceof Error ? e.message : String(e), values)}`);
    }
}

/**
 * Open every connector side by side; none can fail the caller. A tool name
 * already taken — by the platform's tools or an earlier connector — leaves
 * that connector out.
 */
export async function openDaemonConnectors(input: OpenDaemonConnectorsInput): Promise<DaemonConnectors> {
    const outcomes = await Promise.all(input.connectors.map((c) => openOne(c, input)));
    const taken = new Set(input.taken ?? []);
    const tools: AnyTool[] = [];
    const annotations = new Map<string, ToolAnnotations | undefined>();
    const unavailable: UnavailableDaemonConnector[] = [];
    const opened: DaemonOpenedConnector[] = [];
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
