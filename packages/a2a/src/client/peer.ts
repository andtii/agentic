/**
 * A2A peers as runtime plugin instances (#246, PLG-01, PLG-06): a remote A2A
 * agent a user adds is a `kind: runtime` plugin `a2a.<id>` in the workspace
 * Registry, and an agent put on that runtime runs its work on the peer.
 *
 * - `a2aPeer({ id, cardUrl })` mints the manifest: config `{ cardUrl }`, an
 *   optional bearer secret `a2a-<id>-token`, and the `network:<host>` /
 *   `secret:` permissions it uses, declared up front.
 * - `a2aPeerRuntime(runtime)` is the local runtime behind the id: each open
 *   reads the card URL from the plugin's config, opens the token through the
 *   Registry (never kept), and opens an `a2aAgent` session.
 *
 * The id is `a2a.<id>`, not `a2a:<id>`: Registry ids share one alphabet with
 * secret names (letters, digits, `.`, `_`, `-`), and the id is a URL segment
 * (`/plugins/:id`).
 */

import type { ConfigSchema, PermissionScope, PluginManifest } from '@agentic/core';
import type { AgentCapabilities, AgentSession, SessionRef } from '@sigx/ai-agent';
import { a2aAgent } from './agent.js';
import type { FetchLike } from './transport.js';

/** Every A2A peer's runtime id starts with this. */
export const A2A_PEER_PREFIX = 'a2a.';
export const A2A_PEER_VERSION = '0.1.0';
/** What a peer's manifest says it is. */
export const A2A_PEER_CAPABILITIES: readonly string[] = ['a2a-peer'];

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface A2aPeerOptions {
    /** Letters, digits, `_` and `-`; the runtime id is `a2a.<id>`. */
    readonly id: string;
    /** The agent card, or the peer's base URL (the well-known card path is added). */
    readonly cardUrl: string;
    /** Default: the id. */
    readonly name?: string;
    readonly description?: string;
}

/** `a2a.<id>` → `<id>`; `undefined` when `runtime` is not a peer's. */
export function a2aPeerId(runtime: string): string | undefined {
    return runtime.startsWith(A2A_PEER_PREFIX) && runtime.length > A2A_PEER_PREFIX.length ? runtime.slice(A2A_PEER_PREFIX.length) : undefined;
}

export function isA2aPeerRuntime(runtime: string): boolean {
    return a2aPeerId(runtime) !== undefined;
}

/** The peer's bearer token, as a Registry secret name. */
export function a2aPeerTokenSecret(id: string): string {
    return `a2a-${id}-token`;
}

/** A peer id made from a name: lowercase, anything outside the alphabet as `-`. */
export function a2aPeerIdFrom(name: string): string {
    return name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
}

function checkOptions(options: A2aPeerOptions): URL {
    if (!ID_RE.test(options.id)) throw new Error(`[agentic a2a] peer id "${options.id}" must be 1–64 letters, digits, "_" or "-"`);
    let url: URL;
    try {
        url = new URL(options.cardUrl);
    } catch {
        throw new Error(`[agentic a2a] peer card URL "${options.cardUrl}" is not a URL`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`[agentic a2a] peer card URL "${options.cardUrl}" must be http(s)`);
    return url;
}

/** The runtime plugin manifest for one remote A2A agent; register it with `Registry.register(manifest, { enabled: true, grant: 'declared' })`. */
export function a2aPeer(options: A2aPeerOptions): PluginManifest {
    const url = checkOptions(options);
    const secret = a2aPeerTokenSecret(options.id);
    const config: ConfigSchema = {
        type: 'object',
        properties: { cardUrl: { type: 'string', format: 'uri', title: 'Agent card URL', description: "The peer's agent card, or its base URL", default: options.cardUrl } },
        required: ['cardUrl'],
        additionalProperties: false
    };
    const permissions: { scope: PermissionScope; reason: string }[] = [
        { scope: `network:${url.host}`, reason: `Reach the A2A agent at ${url.host}` },
        { scope: `secret:${secret}`, reason: 'Bearer token sent to the agent, when it needs one' }
    ];
    return {
        id: `${A2A_PEER_PREFIX}${options.id}`,
        version: A2A_PEER_VERSION,
        kind: 'runtime',
        name: options.name?.trim() || options.id,
        description: options.description ?? `Remote A2A agent at ${url.host}`,
        capabilities: A2A_PEER_CAPABILITIES,
        config,
        secrets: [{ name: secret, title: 'Bearer token', description: 'Sent as the Authorization header. Leave it unset for an agent that needs none.', required: false }],
        permissions,
        compat: { platform: '*', core: '*' }
    };
}

/** What an open is handed — the platform's `SessionFactoryContext`, as far as a peer reads it. */
export interface A2aPeerOpenContext {
    readonly signal: AbortSignal;
    readonly resume?: SessionRef;
}

/** The plugin behind the open — the platform's `RuntimePluginAccess`, as far as a peer reads it. */
export interface A2aPeerPluginAccess {
    readonly config: Readonly<Record<string, unknown>>;
    secret(name: string): Promise<string | undefined>;
}

export interface A2aPeerRuntimeOptions {
    /** Default `globalThis.fetch`; a test passes its in-process server's. */
    readonly fetch?: FetchLike;
}

/** A local runtime (the platform's `RuntimeImpl`) for the peer runtime id `a2a.<id>`. */
export function a2aPeerRuntime(runtime: string, options: A2aPeerRuntimeOptions = {}) {
    const id = a2aPeerId(runtime);
    if (id === undefined) throw new Error(`[agentic a2a] "${runtime}" is not an A2A peer runtime (${A2A_PEER_PREFIX}<id>)`);
    return {
        host: 'local' as const,
        async open(c: A2aPeerOpenContext, plugin: A2aPeerPluginAccess): Promise<{ session: AgentSession; agentId: string; capabilities: AgentCapabilities; dispose(): Promise<void> }> {
            const cardUrl = plugin.config['cardUrl'];
            if (typeof cardUrl !== 'string' || !cardUrl) throw new Error(`a2a-peer: the "${runtime}" runtime plugin has no agent card URL — set one at /plugins/${runtime}`);
            const token = await plugin.secret(a2aPeerTokenSecret(id));
            const agent = a2aAgent(cardUrl, { id: runtime, ...(options.fetch ? { fetch: options.fetch } : {}), ...(token ? { auth: token } : {}) });
            // The peer's context continues across activations: the ref keeps it.
            const data = c.resume?.data as { readonly contextId?: unknown } | undefined;
            const contextId = typeof data?.contextId === 'string' ? data.contextId : undefined;
            try {
                const session = await agent.session({ signal: c.signal, ...(contextId ? { contextId } : {}) });
                return { session, agentId: agent.id, capabilities: agent.capabilities, dispose: () => agent.dispose() };
            } catch (e) {
                await agent.dispose();
                throw e;
            }
        }
    };
}
