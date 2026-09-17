/**
 * `a2aAgent()` — a remote A2A agent as an `Agent`. The card is fetched once
 * (`connect()`); capabilities are the conservative set until then, and what
 * the card really allows afterwards (AC-14). What the adapter does not
 * translate is listed, not implied (PLG-09).
 */

import { AgentError, capabilities, type Agent, type AgentCapabilities, type AgentSession } from '@sigx/ai-agent';
import type { AgentCard, AgentInterface, AgentSkill } from '../protocol/index.js';
import { AGENTIC_EXTENSION_URI, promptPartsFor } from '../protocol/index.js';
import { openA2aSession, type A2aSessionOptions } from './session.js';
import { cardUrlFor, createA2aRpcClient, fetchAgentCard, type A2aTransportOptions } from './transport.js';

export interface A2aAgentOptions extends A2aTransportOptions {
    /** Default: `a2a:<card name>`. */
    readonly id?: string;
}

/** What the card declares, and what this adapter leaves out. */
export interface A2aSupport {
    readonly streaming: boolean;
    readonly pushNotifications: boolean;
    readonly extendedAgentCard: boolean;
    /** Extension URIs the agent declares. */
    readonly extensions: readonly string[];
    /** The agent speaks the agentic extension: tool calls, requests and usage cross the wire. */
    readonly agentic: boolean;
    readonly skills: readonly AgentSkill[];
    /** Operations and translations this adapter does not provide. */
    readonly unsupported: readonly string[];
}

export interface A2aAgent extends Agent<A2aSessionOptions> {
    /** Fetch the card (if a URL was given) and settle the capabilities. Idempotent. */
    connect(): Promise<AgentCard>;
    /** The card, once connected. */
    readonly card: AgentCard | undefined;
    /** The card's A2A capabilities and this adapter's limits, once connected. */
    readonly a2a: A2aSupport | undefined;
}

/** What this adapter never translates, whatever the card says (PLG-09). */
export const A2A_UNSUPPORTED: readonly string[] = ['push-notifications', 'subscribe-to-task', 'extended-agent-card', 'grpc', 'http+json', 'resume', 'fork', 'structured-output', 'client-tools', 'sub-agents', 'steer', 'configure'];

/** Before the card is known: what every A2A agent can do. */
export const A2A_BASE_CAPABILITIES: AgentCapabilities = capabilities({ cancel: true });

export function capabilitiesFrom(card: AgentCard): AgentCapabilities {
    const agentic = supportFrom(card).agentic;
    return capabilities({
        cancel: true,
        resume: false,
        promptParts: promptPartsFor(card.defaultInputModes),
        tools: 'none',
        // An agentic peer forwards the requests its harness raises; a plain A2A agent asks nothing.
        permissions: agentic ? 'harness-filtered' : 'none'
    });
}

export function supportFrom(card: AgentCard): A2aSupport {
    const extensions = (card.capabilities?.extensions ?? []).map((e) => e.uri).filter((u): u is string => typeof u === 'string');
    return {
        streaming: card.capabilities?.streaming === true,
        pushNotifications: card.capabilities?.pushNotifications === true,
        extendedAgentCard: card.capabilities?.extendedAgentCard === true,
        extensions,
        agentic: extensions.includes(AGENTIC_EXTENSION_URI),
        skills: card.skills ?? [],
        unsupported: A2A_UNSUPPORTED
    };
}

/** The JSON-RPC interface the card prefers (spec §8.3.2). */
export function jsonRpcInterface(card: AgentCard): AgentInterface | undefined {
    return card.supportedInterfaces.find((i) => i.protocolBinding.toUpperCase() === 'JSONRPC');
}

export function a2aAgent(card: string | AgentCard, options: A2aAgentOptions = {}): A2aAgent {
    const sessions = new Set<AgentSession>();
    let resolved: AgentCard | undefined = typeof card === 'string' ? undefined : card;
    let caps: AgentCapabilities = resolved ? capabilitiesFrom(resolved) : A2A_BASE_CAPABILITIES;
    let support: A2aSupport | undefined = resolved ? supportFrom(resolved) : undefined;
    let connecting: Promise<AgentCard> | undefined;
    let disposed = false;
    const id = options.id ?? (resolved ? `a2a:${resolved.name}` : `a2a:${new URL(card as string).host}`);

    async function connect(): Promise<AgentCard> {
        if (disposed) throw new AgentError('protocol_error', `[agentic a2a] agent "${id}" was disposed`);
        connecting ??= (async () => {
            resolved ??= await fetchAgentCard(cardUrlFor(card as string), options);
            caps = capabilitiesFrom(resolved);
            support = supportFrom(resolved);
            return resolved;
        })();
        return connecting;
    }

    const agent: A2aAgent = {
        id,
        get capabilities() {
            return caps;
        },
        get card() {
            return resolved;
        },
        get a2a() {
            return support;
        },
        connect,
        async session(sessionOptions = {}) {
            const c = await connect();
            const iface = jsonRpcInterface(c);
            if (!iface) throw new AgentError('protocol_error', `[agentic a2a] agent "${id}" offers no JSON-RPC interface (bindings: ${c.supportedInterfaces.map((i) => i.protocolBinding).join(', ') || 'none'})`);
            const opened = openA2aSession({ rpc: createA2aRpcClient(iface.url, options), card: c, agentId: id, ...(iface.tenant !== undefined ? { tenant: iface.tenant } : {}), sessionOptions });
            const session: AgentSession = {
                ...opened,
                get ref() {
                    return opened.ref;
                },
                async close() {
                    await opened.close();
                    sessions.delete(session);
                }
            };
            sessions.add(session);
            return session;
        },
        async dispose() {
            disposed = true;
            await Promise.all([...sessions].map((s) => s.close().catch(() => {})));
            sessions.clear();
        }
    };
    return agent;
}
