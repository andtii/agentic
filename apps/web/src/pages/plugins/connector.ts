/**
 * Adding, testing and removing an MCP server from `/plugins` (#241; PLG-03,
 * AST-09). One server is one connector plugin: `mcpConnectorSetup` gives the
 * manifest `Registry.register` installs (enabled, its declared scopes
 * granted) and the record `Registry.putConnector` stores under the same id;
 * the credential the dialog took goes through `Registry.setSecret` and is
 * never written anywhere else. "Test connection" is `openMcpConnector` run
 * from the page with the values still in the form — the tools it lists, or
 * why it failed, are what `setConnectorStatus` records, and the tools it
 * found (with their read-only / destructive hints) are what the manifest
 * declares, so each gets a policy row that starts where its hints say
 * (PLG-09). Nothing here draws.
 */
import { connectorToolPrefix, mcpConnectorSetup, openMcpConnector, type FetchLike, type McpHttpConnector } from '@agentic/mcp';
import type { ConnectorRecord, ConnectorStatus, Dependents, PluginView } from '@agentic/platform';
import type { PluginManifest } from '@agentic/core';

/** How the server takes its credential. */
export type ConnectorAuthKind = 'none' | 'bearer' | 'header';

/** What the dialog edits; strings so the fields bind straight to it. */
export interface ConnectorDraft {
    name: string;
    url: string;
    auth: ConnectorAuthKind;
    /** The header that carries the credential when `auth` is `header` (`X-Api-Key`). */
    header: string;
    /** The credential's value — kept in the dialog until `Registry.setSecret` seals it, never shown again. Used trimmed: a pasted newline is not part of a token. */
    secret: string;
}

export const emptyConnectorDraft = (): ConnectorDraft => ({ name: '', url: '', auth: 'none', header: '', secret: '' });

export const CONNECTOR_AUTH_OPTIONS: readonly { readonly value: ConnectorAuthKind; readonly label: string }[] = [
    { value: 'none', label: 'None' },
    { value: 'bearer', label: 'Bearer token' },
    { value: 'header', label: 'API key header' }
];

/** The plugin and connector id a name becomes: lower case, letters, digits, `.`, `_` and `-` (the Registry's name rule). */
export function connectorIdOf(name: string): string {
    return name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^[-.]+|[-.]+$/g, '')
        .slice(0, 100);
}

/** The Registry secret a connector's credential is sealed under. */
export const connectorSecretName = (id: string): string => `${id}.token`;

export type ConnectorDraftErrors = Partial<Record<'name' | 'url' | 'header' | 'secret', string>>;

const HEADER_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/** Every reason the draft cannot be added yet; `taken` is the plugin ids already in the Registry. */
export function validateConnectorDraft(draft: ConnectorDraft, taken: ReadonlySet<string>): ConnectorDraftErrors {
    const errors: ConnectorDraftErrors = {};
    const id = connectorIdOf(draft.name);
    if (!draft.name.trim()) errors.name = 'Give it a name.';
    else if (!id) errors.name = 'Use letters or digits in the name.';
    else if (taken.has(id)) errors.name = `A plugin called "${id}" already exists.`;
    const url = draft.url.trim();
    if (!url) errors.url = 'The server’s Streamable HTTP URL.';
    else {
        let parsed: URL | null = null;
        try {
            parsed = new URL(url);
        } catch {
            parsed = null;
        }
        if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) errors.url = 'An http(s) URL, like https://mcp.example.com/mcp.';
    }
    if (draft.auth === 'header' && !HEADER_RE.test(draft.header.trim())) errors.header = 'A header name, like X-Api-Key.';
    if (draft.auth !== 'none' && !draft.secret.trim()) errors.secret = draft.auth === 'bearer' ? 'The token the server expects.' : 'The key the header carries.';
    return errors;
}

/** The `mcpConnector` options the draft stands for. */
export function connectorOptions(draft: ConnectorDraft): McpHttpConnector {
    const id = connectorIdOf(draft.name);
    const secret = connectorSecretName(id);
    return {
        id,
        name: draft.name.trim(),
        transport: 'streamable-http',
        url: draft.url.trim(),
        ...(draft.auth === 'bearer' ? { secret } : {}),
        ...(draft.auth === 'header' ? { headerSecrets: { [draft.header.trim()]: secret } } : {})
    };
}

/**
 * One tool the probe found, as the manifest declares it (`mcpConnector`'s `tools`).
 * Built from the opened session's tools, so `name` is the sanitized, unprefixed
 * name (a server's `delete.repo` arrives as `delete_repo`), not the raw
 * `tools/list` name; it maps back to the same session name. A server `title` is
 * not carried through, and a title-only tool shows its title as the description.
 */
export type ProbedTool = NonNullable<McpHttpConnector['tools']>[number];

export type ConnectorProbe =
    | {
          readonly ok: true;
          /** The tools' names as agents see them (`acme__ping`). */
          readonly tools: readonly string[];
          /** The same tools with their descriptions and hints, for the manifest's per-tool policy rows. */
          readonly declared?: readonly ProbedTool[];
      }
    | { readonly ok: false; readonly error: string };

/** A failure as the page shows it — with the credential cut out, should a server have echoed it back. */
function probeError(e: unknown, secret: string): string {
    const message = e instanceof Error ? e.message : String(e);
    return (secret ? message.split(secret).join('••••') : message).replace(/^\[agentic mcp\]\s*/, '');
}

/**
 * "Test connection": connect with the draft's own values, list the tools
 * (`<id>__<tool>`, as agents will see them) and close. Run from the page,
 * so a server that refuses browser requests (CORS) fails here and may still
 * work for agents; the answer says what happened, never the credential.
 */
export async function probeConnector(draft: ConnectorDraft, options: { readonly fetch?: FetchLike; readonly timeoutMs?: number } = {}): Promise<ConnectorProbe> {
    const id = connectorIdOf(draft.name) || 'connector';
    const header = draft.header.trim();
    const secret = draft.secret.trim();
    try {
        const opened = await openMcpConnector({
            id,
            url: draft.url.trim(),
            ...(draft.auth === 'bearer' ? { bearer: secret } : {}),
            ...(draft.auth === 'header' ? { headers: { [header]: secret } } : {}),
            ...(options.fetch ? { fetch: options.fetch } : {}),
            ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {})
        });
        const tools = [...opened.toolNames];
        const declared = opened.tools.map((t): ProbedTool => {
            const a = t.annotations;
            const annotations = {
                ...(a?.readOnly !== undefined ? { readOnlyHint: a.readOnly } : {}),
                ...(a?.destructive !== undefined ? { destructiveHint: a.destructive } : {}),
                ...(a?.idempotent !== undefined ? { idempotentHint: a.idempotent } : {}),
                ...(a?.openWorld !== undefined ? { openWorldHint: a.openWorld } : {})
            };
            const name = unprefixed(id, t.name);
            return {
                name,
                // `mcpTool` falls back to the name for a tool the server left undescribed; that is no description.
                ...(t.description && t.description !== name ? { description: t.description } : {}),
                ...(Object.keys(annotations).length ? { annotations } : {})
            };
        });
        await opened.close().catch(() => undefined);
        return { ok: true, tools, declared };
    } catch (e) {
        return { ok: false, error: probeError(e, secret) };
    }
}

/** A session tool name without its connector's prefix — the server's name, as `mcpConnector` takes it. */
function unprefixed(id: string, name: string): string {
    const prefix = connectorToolPrefix(id);
    return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/** The Registry methods adding and removing a connector call — the actor client, structurally. */
export interface ConnectorRegistry {
    register(manifest: PluginManifest, options: { readonly enabled: boolean; readonly grant: 'declared' }): Promise<PluginView>;
    putConnector(input: ReturnType<typeof mcpConnectorSetup>['connector']): Promise<ConnectorRecord>;
    setSecret(name: string, value: string): Promise<unknown>;
    setConnectorStatus(id: string, status: ConnectorStatus, tools?: readonly string[]): Promise<ConnectorRecord>;
    remove(id: string, options?: { readonly force?: boolean }): Promise<{ removed: true; dependents: Dependents }>;
}

/**
 * Install the server: the plugin (enabled, its declared scopes granted), its
 * connector record, its credential, and — when the dialog tested it — what
 * the test found: the status, and the tools the manifest declares with their
 * default modes. Untested, the manifest declares no tools; the plugin page
 * reads the connector record's once a session has opened it. Returns the id
 * agents pick it by.
 */
export async function addConnector(registry: ConnectorRegistry, draft: ConnectorDraft, probe?: ConnectorProbe): Promise<string> {
    const probed = probe?.ok ? (probe.declared ?? probe.tools.map((name) => ({ name: unprefixed(connectorIdOf(draft.name), name) }))) : undefined;
    const { manifest, connector } = mcpConnectorSetup({ ...connectorOptions(draft), ...(probed ? { tools: probed } : {}) });
    await registry.register(manifest, { enabled: true, grant: 'declared' });
    await registry.putConnector(connector);
    for (const s of manifest.secrets ?? []) await registry.setSecret(s.name, draft.secret.trim());
    if (probe) await registry.setConnectorStatus(connector.id, probe.ok ? { state: 'ok' } : { state: 'error', error: probe.error }, probe.ok ? probe.tools : undefined);
    return connector.id;
}

/** What the connector list says about one record's last check. */
export function connectorStatusLabel(c: Pick<ConnectorRecord, 'status' | 'tools'>): string {
    if (c.status.state === 'ok') return `${c.tools.length} ${c.tools.length === 1 ? 'tool' : 'tools'}`;
    return c.status.state === 'error' ? 'ERROR' : 'UNCHECKED';
}
