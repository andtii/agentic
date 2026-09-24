/**
 * `mcpConnector` — the `PluginManifest` (kind `connector`) for one MCP
 * server, so the Registry can hold enabled/config/grantedPermissions for it
 * like any other plugin (PLG-01..05, AST-09). Permissions are declared up
 * front: the network host it reaches (or the machine that runs the process),
 * the secrets it needs, and the tool namespace it exposes. Nothing implicit.
 *
 * Credentials are never config (decisions 2026-09-19 (a)): a bearer token,
 * a credential header or a process environment variable names a Registry
 * secret, declared in `manifest.secrets` with its `secret:<name>` scope.
 * `mcpConnectorSetup` gives the manifest AND the connector record that
 * binds each secret to where it goes — what the app stores to add a server.
 *
 * Capabilities name what works (`tools`, …) and, prefixed `unsupported:`,
 * what does not (resources, prompts, sampling, elicitation, …) — PLG-09 asks
 * for the gaps to be declared, and a manifest is where a reader looks first.
 *
 * Tools a probe found (`tools`) become `manifest.tools`: each under the name
 * a session sees (`<namespace>__<tool>`), starting in the mode its MCP
 * annotations suggest (`defaultToolMode`: destructive asks), so an MCP
 * server gets the same per-tool policy rows as a conduit connector (PLG-09).
 * Without a probe the manifest declares none.
 */

import { defaultToolMode, type ConfigSchema, type PermissionScope, type PluginManifest, type PluginSecretDeclaration, type PluginToolDeclaration } from '@agentic/core';
import { MCP_SUPPORTED_OPS, MCP_UNSUPPORTED_OPS } from './capabilities.js';
import type { McpToolAnnotations } from './protocol.js';
import { toolNameFor } from './tools.js';

/** Capability strings a connector manifest carries: what works, then `unsupported:<op>` for each gap. */
export const MCP_CONNECTOR_CAPABILITIES: readonly string[] = [...MCP_SUPPORTED_OPS, ...MCP_UNSUPPORTED_OPS.map((u) => `unsupported:${u.op}`)];

/**
 * The tool namespace of a connector: its id as a provider accepts it (`.` → `_`).
 * Its tools reach a session as `<namespace>__<tool>`; the manifest declares `tools:<namespace>`.
 */
export function connectorNamespace(id: string): string {
    return toolNameFor(id);
}

/** What every tool name of connector `id` starts with (`github__`). */
export function connectorToolPrefix(id: string): string {
    return `${connectorNamespace(id)}__`;
}

/** One tool a probe of the server found, as `tools/list` gave it (its name unprefixed). */
export interface McpConnectorTool {
    readonly name: string;
    readonly title?: string;
    readonly description?: string;
    readonly annotations?: McpToolAnnotations;
}

export interface McpConnectorBase {
    /** Plugin id and connector id; its tools are namespaced `<id>__<tool>`. Letters, digits, `.`, `_`, `-`. */
    readonly id: string;
    readonly name: string;
    readonly description?: string;
    readonly version?: string;
    /** Extra permissions the host wants recorded (`memory:read`, say). */
    readonly permissions?: readonly { readonly scope: PermissionScope; readonly reason: string }[];
    readonly compat?: PluginManifest['compat'];
    /** The tools a probe found; declared in `manifest.tools` under their session names. Omitted: none declared. */
    readonly tools?: readonly McpConnectorTool[];
}

export interface McpHttpConnector extends McpConnectorBase {
    readonly transport: 'streamable-http';
    readonly url: string | URL;
    /** Name of the secret holding the bearer token, when the server needs one; declares `secret:<name>`. */
    readonly secret?: string;
    /** Credential headers: header name → the secret whose value it carries (`{ 'X-Api-Key': 'acme.key' }`). Each declares `secret:<name>`. */
    readonly headerSecrets?: Readonly<Record<string, string>>;
}

export interface McpStdioConnector extends McpConnectorBase {
    readonly transport: 'stdio';
    readonly command: string;
    readonly args?: readonly string[];
    /** The machine whose daemon spawns the process; `*` when any paired machine may. */
    readonly machine?: string;
    /** Secrets passed to the process environment under their own name; each declares `secret:<name>`. */
    readonly secrets?: readonly string[];
    /** Environment variable → the secret whose value it carries (`{ GITHUB_TOKEN: 'github.token' }`). Each declares `secret:<name>`. */
    readonly envSecrets?: Readonly<Record<string, string>>;
}

export type McpConnectorOptions = McpHttpConnector | McpStdioConnector;

/** Where each secret of a connector goes; names only — the values stay sealed in the Registry until a session opens. */
export interface McpConnectorAuth {
    /** Sent as `Authorization: Bearer <value>` (Streamable HTTP). */
    readonly bearer?: string;
    /** Header name → secret name (Streamable HTTP). */
    readonly headers?: Readonly<Record<string, string>>;
    /** Environment variable → secret name (stdio). */
    readonly env?: Readonly<Record<string, string>>;
}

/** The connector record `Registry.putConnector` takes, structurally (`ConnectorInput` of `@agentic/platform`). */
export interface McpConnectorRecordInput {
    readonly id: string;
    readonly pluginId: string;
    readonly transport: 'streamable-http' | 'stdio';
    readonly url?: string;
    readonly command?: string;
    readonly args?: readonly string[];
    readonly machine?: string;
    /** Every secret name the connector reads. */
    readonly secrets: readonly string[];
    readonly auth?: McpConnectorAuth;
}

/** The endpoint, editable on the plugin's page; no credential lives here — `secret` / `headerSecrets` do. */
function httpConfigSchema(url: string): ConfigSchema {
    return {
        type: 'object',
        properties: { url: { type: 'string', format: 'uri', title: 'URL', description: 'Streamable HTTP endpoint', default: url } },
        required: ['url'],
        additionalProperties: false
    };
}

/** What the daemon spawns; credentials go in `envSecrets`, never in the config. */
function stdioConfigSchema(command: string, args: readonly string[] | undefined): ConfigSchema {
    return {
        type: 'object',
        properties: {
            command: { type: 'string', title: 'Command', description: 'Executable the daemon spawns', default: command },
            args: { type: 'array', items: { type: 'string' }, title: 'Arguments', ...(args ? { default: [...args] } : {}) },
            cwd: { type: 'string', title: 'Working folder' }
        },
        required: ['command'],
        additionalProperties: false
    };
}

function checkId(id: string): void {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`[agentic mcp] connector id "${id}" must be letters, digits, ".", "_" or "-"`);
}

interface SecretBinding {
    readonly name: string;
    readonly title: string;
    readonly reason: string;
}

/** Every secret `options` reads, once each, in declaration order, with where it goes. */
function secretBindings(options: McpConnectorOptions): SecretBinding[] {
    const out: SecretBinding[] = [];
    const add = (name: string, title: string, reason: string): void => {
        if (!out.some((b) => b.name === name)) out.push({ name, title, reason });
    };
    if (options.transport === 'streamable-http') {
        if (options.secret !== undefined) add(options.secret, 'Bearer token', 'Bearer token sent on every request');
        for (const [header, name] of Object.entries(options.headerSecrets ?? {})) add(name, header, `Sent as the ${header} header on every request`);
    } else {
        for (const name of options.secrets ?? []) add(name, name, 'Passed to the process environment');
        for (const [variable, name] of Object.entries(options.envSecrets ?? {})) add(name, variable, `Passed to the process as ${variable}`);
    }
    return out;
}

/** The probed tools as manifest declarations: session name, default mode from the annotations; a name seen twice counts once. */
function toolDeclarations(id: string, tools: readonly McpConnectorTool[]): PluginToolDeclaration[] {
    const prefix = connectorToolPrefix(id);
    const out: PluginToolDeclaration[] = [];
    for (const t of tools) {
        const name = toolNameFor(t.name, prefix);
        if (out.some((d) => d.name === name)) continue;
        const title = t.title ?? t.annotations?.title;
        out.push({ name, ...(title ? { title } : {}), ...(t.description ? { description: t.description } : {}), defaultMode: defaultToolMode(t.annotations) });
    }
    return out;
}

export function mcpConnector(options: McpConnectorOptions): PluginManifest {
    checkId(options.id);
    const permissions: { scope: PermissionScope; reason: string }[] = [];
    let config: ConfigSchema;
    if (options.transport === 'streamable-http') {
        const host = new URL(String(options.url)).host;
        permissions.push({ scope: `network:${host}`, reason: `Reach the MCP server at ${host}` });
        config = httpConfigSchema(String(options.url));
    } else {
        const machine = options.machine ?? '*';
        permissions.push({ scope: `machine:${machine}`, reason: `Spawn "${options.command}" on the machine's daemon` });
        config = stdioConfigSchema(options.command, options.args);
    }
    const bindings = secretBindings(options);
    for (const b of bindings) permissions.push({ scope: `secret:${b.name}`, reason: b.reason });
    permissions.push({ scope: `tools:${connectorNamespace(options.id)}`, reason: "Expose this server's tools to agents that enable the connector" });
    permissions.push(...(options.permissions ?? []));
    const secrets: PluginSecretDeclaration[] = bindings.map((b) => ({ name: b.name, title: b.title, description: b.reason, required: true }));
    return {
        id: options.id,
        version: options.version ?? '0.0.0',
        kind: 'connector',
        name: options.name,
        description: options.description ?? (options.transport === 'streamable-http' ? `MCP server at ${String(options.url)}` : `MCP server "${options.command}" over stdio`),
        capabilities: MCP_CONNECTOR_CAPABILITIES,
        config,
        ...(secrets.length ? { secrets } : {}),
        permissions,
        compat: options.compat ?? { platform: '*', core: '*' },
        ...(options.tools ? { tools: toolDeclarations(options.id, options.tools) } : {})
    };
}

/**
 * Everything the app stores to add one MCP server: the manifest for
 * `Registry.register(manifest, …)` and the record for `Registry.putConnector(connector)`
 * (same id: one server is one plugin). Secret VALUES go through `Registry.setSecret(name, value)`
 * for each `manifest.secrets` entry — never through either of these.
 */
export function mcpConnectorSetup(options: McpConnectorOptions): { readonly manifest: PluginManifest; readonly connector: McpConnectorRecordInput } {
    const manifest = mcpConnector(options);
    const secrets = secretBindings(options).map((b) => b.name);
    if (options.transport === 'streamable-http') {
        const headers = options.headerSecrets && Object.keys(options.headerSecrets).length ? { headers: { ...options.headerSecrets } } : {};
        const auth: McpConnectorAuth = { ...(options.secret !== undefined ? { bearer: options.secret } : {}), ...headers };
        return { manifest, connector: { id: options.id, pluginId: options.id, transport: 'streamable-http', url: String(options.url), secrets, ...(Object.keys(auth).length ? { auth } : {}) } };
    }
    const env: Record<string, string> = {};
    for (const name of options.secrets ?? []) env[name] = name;
    Object.assign(env, options.envSecrets ?? {});
    return {
        manifest,
        connector: {
            id: options.id,
            pluginId: options.id,
            transport: 'stdio',
            command: options.command,
            ...(options.args ? { args: [...options.args] } : {}),
            ...(options.machine !== undefined ? { machine: options.machine } : {}),
            secrets,
            ...(Object.keys(env).length ? { auth: { env } } : {})
        }
    };
}
