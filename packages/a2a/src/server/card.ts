/** The Agent Card of an exposed agent (spec §4.4, §8). */

import type { AgentCard } from '../protocol/index.js';
import { A2A_PROTOCOL_VERSION, AGENTIC_EXTENSION_URI, EVENT_MEDIA_TYPE, inputModesFor } from '../protocol/index.js';
import type { ExposedAgent } from './ports.js';

/** Build the card for `agent` served at `endpointUrl` (the JSON-RPC URL). */
export function agentCard(agent: ExposedAgent, endpointUrl: string): AgentCard {
    return {
        name: agent.name,
        description: agent.description,
        version: agent.version ?? '0.0.0',
        supportedInterfaces: [{ url: endpointUrl, protocolBinding: 'JSONRPC', protocolVersion: A2A_PROTOCOL_VERSION }],
        ...(agent.provider ? { provider: agent.provider } : {}),
        ...(agent.documentationUrl ? { documentationUrl: agent.documentationUrl } : {}),
        ...(agent.iconUrl ? { iconUrl: agent.iconUrl } : {}),
        capabilities: {
            streaming: true,
            pushNotifications: false,
            extendedAgentCard: false,
            extensions: [{ uri: AGENTIC_EXTENSION_URI, description: 'Tool calls, requests, usage and the turn result travel as data parts.', required: false }]
        },
        defaultInputModes: [...(agent.inputModes ?? inputModesFor(agent.promptParts ?? 'text'))],
        defaultOutputModes: [...(agent.outputModes ?? ['text/plain', EVENT_MEDIA_TYPE])],
        skills: agent.skills ? [...agent.skills] : [{ id: 'chat', name: agent.name, description: agent.description, tags: ['chat'] }]
    };
}

/** A weak ETag from the card's content (spec §8.6.1). */
export function cardEtag(card: AgentCard): string {
    const text = JSON.stringify(card);
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    return `W/"${card.version}-${(h >>> 0).toString(16)}"`;
}
