/**
 * Whose credential a project's pull requests are polled with (#840; PRJ-08). The Pulls actor reads each project's
 * repo with that project's GitHub credential: a `TokenPullSourcesOptions.token` that looks, in order, at
 *
 * 1. the project's own connectors (`ProjectRecord.connectors`): the first the Registry records as the ref's
 *    provider's (`github` — its id, plugin or conduit connector id) whose secret is set, opened under its plugin's
 *    `secret:` grant;
 * 2. the workspace's connector of that id (`github`), when the project names none that answers;
 * 3. the workspace fallback (#793): the git feature's `github-token` secret.
 *
 * Nothing found → `undefined`: the actor shows `needs-sign-in` instead of failing silently. The token is returned,
 * never logged; every open is the Registry's own `secret.opened` audit row, which names the secret, not its value.
 */
import type { ConnectorRef, ProjectRecord } from '@agentic/core';
import { actor, type AnyActorDefinition } from '@sigx/actors';
import { asPrincipal, userPrincipal, workspaceKey } from '../auth/index.js';
import { registryKey } from '../registry/key.js';
import type { ConnectorRecord } from '../registry/types.js';
import { registryPullToken, type PullSourceRef } from './ports.js';

export interface ProjectPullTokenOptions {
    /** The Registry definition, as a thunk like the other actor ports. */
    readonly registry: () => AnyActorDefinition;
    /** The Workspace definition, whose `projects()` names each project's connectors. */
    readonly workspace: () => AnyActorDefinition;
    /** The workspace fallback's plugin (the git feature, `agentic.feature.git`). */
    readonly pluginId: string;
    /** The workspace fallback's secret (`github-token`). */
    readonly secret: string;
}

interface WorkspaceProjects {
    projects(): Promise<readonly ProjectRecord[]>;
}

interface RegistryConnectors {
    getConnector(id: string): Promise<ConnectorRecord | null>;
}

/** Whether a connector record is the provider's (`github`): by its id, its plugin or its conduit connector id. */
export function isProviderConnector(record: Pick<ConnectorRecord, 'id' | 'pluginId' | 'connector'>, provider: string): boolean {
    return record.id === provider || record.pluginId === provider || record.connector === provider;
}

/** The secret a connector authenticates with: its bearer, else the first it lists. Conduit records hold none. */
export function connectorSecretOf(record: Pick<ConnectorRecord, 'auth' | 'secrets'>): string | undefined {
    return record.auth?.bearer ?? record.secrets?.[0];
}

/**
 * The per-project credential lookup (#840) — the resolution order above. A Registry refusal that means "no
 * credential" (no secret, no grant, plugin off) moves on to the next candidate; any other failure throws, as
 * `registryPullToken` does.
 */
export function projectPullToken(options: ProjectPullTokenOptions): (ref: PullSourceRef) => Promise<string | undefined> {
    const fallback = registryPullToken({ registry: options.registry, pluginId: options.pluginId, secret: options.secret });
    return async (ref) => {
        const context = asPrincipal(userPrincipal(ref.workspaceId, ref.workspaceId));
        const registry = actor(options.registry(), registryKey(ref.workspaceId)).with({ context }) as unknown as RegistryConnectors;
        const workspace = actor(options.workspace(), workspaceKey(ref.workspaceId)).with({ context }) as unknown as WorkspaceProjects;
        const project = (await workspace.projects()).find((p) => p.id === ref.projectId);
        const named: readonly ConnectorRef[] = project?.connectors ?? [];
        const tried = new Set<string>();
        const fromConnector = async (id: string): Promise<string | undefined> => {
            if (tried.has(id)) return undefined;
            tried.add(id);
            const record = await registry.getConnector(id);
            if (!record || !isProviderConnector(record, ref.provider)) return undefined;
            const secret = connectorSecretOf(record);
            if (secret === undefined) return undefined;
            return registryPullToken({ registry: options.registry, pluginId: record.pluginId, secret })(ref);
        };
        for (const c of named) {
            const token = await fromConnector(c.id);
            if (token) return token;
        }
        return (await fromConnector(ref.provider)) ?? (await fallback(ref));
    };
}
