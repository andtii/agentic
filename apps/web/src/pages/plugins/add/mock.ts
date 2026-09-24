/**
 * The Add connector page on mock data (#639): GitHub is connected, as the `AddConnector` board draws it, and every
 * other listing — Gmail included — can be connected, so the whole flow (preview → Connect → choose agents → the
 * plugin page) can be walked without a platform. Connecting signs in at once; adding to agents records the
 * versions it would write in `log` and changes nothing else.
 */
import { signal } from 'sigx';
import type { AgentHue } from '@agentic/ui';
import { AGENTS } from '../../../mock/workspace';
import { listingPluginId } from '../../../plugins/listings';
import { connectorIdOf } from '../connector';
import type { AddConnectorPort } from './AddConnectorView';
import { addedReason } from './model';

/** What the mock board shows connected. */
export const MOCK_CONNECTED: readonly string[] = ['github'];

export interface MockAddedVersion {
    readonly agentId: string;
    readonly pluginId: string;
    readonly reason: string;
}

export function mockAddConnectorPort(log: MockAddedVersion[] = []): AddConnectorPort {
    const st = signal<{ connected: string[] }>({ connected: [...MOCK_CONNECTED] });
    return {
        connected: () => new Set(st.connected),
        taken: () => new Set(st.connected),
        agents: () => AGENTS.map((a) => ({ id: a.id, name: a.name, role: a.role, hue: a.hue as AgentHue })),
        async connectConduit(listing) {
            st.connected = [...st.connected, listingPluginId(listing)];
            return 'connected';
        },
        async addMcp({ draft }) {
            const id = connectorIdOf(draft.name);
            st.connected = [...st.connected, id];
            return id;
        },
        async addToAgents(pluginId, name, agentIds) {
            for (const agentId of agentIds) log.push({ agentId, pluginId, reason: addedReason(name) });
        }
    };
}
