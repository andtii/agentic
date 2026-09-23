/**
 * Connector plugin manifests for conduit connectors (PLG-01, PLG-04, AGT-09).
 * One conduit connector is one `kind: 'connector'` plugin. Everything it may
 * touch is declared: the OAuth client's two secrets, the hosts it calls and
 * its tool namespace. Its capabilities name every operation an agent can
 * call (`operation:<id>`) and, prefixed `unsupported:`, what the connector
 * has that agentic does not run yet (triggers, #535).
 */

import type { ConnectorSpec } from '@aigntiq/conduit';
import type { PermissionScope, PluginManifest } from '@agentic/core';
import gmail from '@aigntiq/conduit-connectors/gmail';
import { CONNECTOR_CLIENT_ID_SECRET, CONNECTOR_CLIENT_SECRET_SECRET } from './clients.js';
import { connectorNamespace, isToolOperation } from './tools.js';

export interface ConduitConnectorManifestOptions {
    /** Hosts the connector's requests reach — its API, its token and revoke endpoints. */
    readonly hosts: readonly string[];
    /** Plugin id. Default: the connector's id. */
    readonly id?: string;
}

/** Capability strings: the operations agents can call, then `unsupported:<kind>:<id>` for the rest. */
export function conduitCapabilities(spec: ConnectorSpec): string[] {
    const out = spec.operations.filter(isToolOperation).map((op) => `operation:${op.id}`);
    for (const op of spec.operations) if (op.kind === 'trigger') out.push(`unsupported:trigger:${op.id}`);
    return out;
}

export function conduitConnectorManifest(spec: ConnectorSpec, options: ConduitConnectorManifestOptions): PluginManifest {
    const id = options.id ?? spec.id;
    const permissions: { scope: PermissionScope; reason: string }[] = [
        { scope: `secret:${CONNECTOR_CLIENT_ID_SECRET}`, reason: `The OAuth client id ${spec.name} signs in with` },
        { scope: `secret:${CONNECTOR_CLIENT_SECRET_SECRET}`, reason: `The OAuth client secret ${spec.name} signs in with` },
        ...options.hosts.map((host) => ({ scope: `network:${host}` as const, reason: `Call ${host}` })),
        { scope: `tools:${connectorNamespace(id)}`, reason: `Expose ${spec.name}'s operations to agents that enable the connector` }
    ];
    return {
        id,
        version: spec.version,
        kind: 'connector',
        name: spec.name,
        description: spec.description ?? spec.name,
        capabilities: conduitCapabilities(spec),
        config: { type: 'object', properties: {}, additionalProperties: false },
        secrets: [
            { name: CONNECTOR_CLIENT_ID_SECRET, title: 'OAuth client ID', description: `From the OAuth client you created for ${spec.name}`, required: true },
            { name: CONNECTOR_CLIENT_SECRET_SECRET, title: 'OAuth client secret', description: `From the OAuth client you created for ${spec.name}`, required: true }
        ],
        permissions,
        compat: { platform: '*', core: '*' }
    };
}

/** Gmail (`@aigntiq/conduit-connectors/gmail`): the first catalogue entry. */
export const gmailConnectorPlugin: PluginManifest = conduitConnectorManifest(gmail, { hosts: ['gmail.googleapis.com', 'oauth2.googleapis.com'] });
