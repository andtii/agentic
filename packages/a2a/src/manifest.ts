/**
 * The A2A server as a plugin (PLG-06): the manifest the composition root puts
 * in its catalogue beside the mounted handler. Off until the owner turns it on
 * (the catalogue entry says `enabledByDefault: false`); its one setting names
 * the agents a remote A2A client may reach. Nothing here mounts anything.
 */

import type { PluginManifest } from '@agentic/core';

export const A2A_SERVER_PLUGIN_ID = 'agentic.a2a.server';
export const A2A_PLUGIN_VERSION = '0.1.0';

/** The config the server reads: which agents get a card and take tasks. */
export interface A2aServerConfig {
    /** Agent ids — or names, matched without regard to case — of the agents exposed over A2A. */
    readonly exposedAgents: readonly string[];
}

/**
 * No permissions: the server opens no secret and reaches no machine itself.
 * A remote client's task runs as an ordinary task of the exposed agent — under
 * that agent's runtime, approvals and grants — and the client needs an OAuth
 * grant with the `tasks` and `sessions` scopes.
 */
export const a2aServerPlugin: PluginManifest = {
    id: A2A_SERVER_PLUGIN_ID,
    version: A2A_PLUGIN_VERSION,
    kind: 'a2a',
    name: 'A2A server',
    description: 'Lets remote A2A 1.0 clients discover the agents you choose and give them tasks. Clients sign in with OAuth like MCP clients do.',
    capabilities: ['a2a-server'],
    config: {
        type: 'object',
        properties: {
            exposedAgents: {
                type: 'array',
                items: { type: 'string' },
                title: 'Exposed agents',
                description: 'The agents a remote client can see and give tasks to, by id or name. None until you add one.',
                default: []
            }
        },
        additionalProperties: false
    },
    permissions: [],
    compat: { platform: '*', core: '*' }
};
