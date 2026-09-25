/**
 * `projectPullToken` (#840): a project's pull requests are polled with the project's own GitHub connector, else the
 * workspace's `github` connector, else the workspace fallback secret — and the token is never written to the audit.
 */
import type { ProjectId, WorkspaceId } from '@agentic/core';
import { mcpConnectorSetup } from '@agentic/mcp';
import { AuditActor, auditKey } from '../../src/audit/index';
import { generateWorkspaceKek, importWorkspaceKek, workspaceKey } from '../../src/auth/index';
import { connectorSecretOf, isProviderConnector, projectPullToken, type PullSourceRef } from '../../src/pulls/index';
import { defineRegistry, registryKey } from '../../src/registry/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';
import { Workspace } from '../../src/workspace/index';
import { AgentActor } from '../../src/agent/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const KEK = generateWorkspaceKek();
const Registry = defineRegistry({ kek: () => importWorkspaceKek(KEK) });

let app: TestActorApp;
beforeEach(async () => {
    app = testActorApp([Registry, AuditActor, Workspace, AgentActor]);
    await app.start();
});
afterEach(() => app.stop());

const reg = () => app.as(owner).actor(Registry, registryKey(WS));
const ws = () => app.as(owner).actor(Workspace, workspaceKey(WS));
const token = projectPullToken({ registry: () => Registry, workspace: () => Workspace, pluginId: 'fallback', secret: 'github-token' });
const refOf = (projectId: ProjectId): PullSourceRef => ({ workspaceId: WS, projectId, provider: 'github', repo: 'octo/agentic' });

/** A GitHub MCP connector under `id`, reading its bearer from `secret`. */
async function githubConnector(id: string, secret: string, value?: string): Promise<void> {
    const setup = mcpConnectorSetup({ id, name: id, transport: 'streamable-http', url: 'https://api.githubcopilot.com/mcp/', secret });
    await reg().register(setup.manifest, { enabled: true, grant: 'declared' });
    await reg().putConnector({ ...setup.connector, ...(id === 'github' ? {} : { connector: 'github' }) });
    if (value !== undefined) await reg().setSecret(secret, value);
}

describe('projectPullToken: resolution order', () => {
    it('project connector → workspace github connector → workspace fallback secret → none', async () => {
        const fallback = mcpConnectorSetup({ id: 'fallback', name: 'Fallback', transport: 'streamable-http', url: 'https://fallback.test/mcp', secret: 'github-token' });
        await reg().register(fallback.manifest, { enabled: true, grant: 'declared' });
        const project = await ws().upsertProject({ name: 'Agentic', connectors: [{ id: 'gh-agentic' }] });
        const bare = await ws().upsertProject({ name: 'Other' });

        // Nothing anywhere: no credential.
        expect(await token(refOf(project.id))).toBeUndefined();

        // The workspace fallback secret.
        await reg().setSecret('github-token', 'tok_fallback');
        expect(await token(refOf(project.id))).toBe('tok_fallback');

        // The workspace's `github` connector beats the fallback.
        await githubConnector('github', 'github.token', 'tok_workspace');
        expect(await token(refOf(project.id))).toBe('tok_workspace');
        expect(await token(refOf(bare.id))).toBe('tok_workspace');

        // The project's own connector beats both — only for that project.
        await githubConnector('gh-agentic', 'gh-agentic.token', 'tok_project');
        expect(await token(refOf(project.id))).toBe('tok_project');
        expect(await token(refOf(bare.id))).toBe('tok_workspace');

        // Another provider's ref never takes a GitHub connector's secret.
        expect(await token({ ...refOf(project.id), provider: 'gitlab' })).toBe('tok_fallback');
    });

    it('a project connector whose secret is unset, or that is not GitHub, falls through', async () => {
        const acme = mcpConnectorSetup({ id: 'acme', name: 'Acme', transport: 'streamable-http', url: 'https://mcp.acme.test/mcp', secret: 'acme.token' });
        await reg().register(acme.manifest, { enabled: true, grant: 'declared' });
        await reg().putConnector(acme.connector);
        await reg().setSecret('acme.token', 'tok_acme');
        await githubConnector('gh-agentic', 'gh-agentic.token');
        await githubConnector('github', 'github.token', 'tok_workspace');
        const project = await ws().upsertProject({ name: 'Agentic', connectors: [{ id: 'acme' }, { id: 'gh-agentic' }, { id: 'ghost' }] });
        expect(await token(refOf(project.id))).toBe('tok_workspace');
        // A disabled connector plugin is no credential either.
        await reg().disable('github');
        expect(await token(refOf(project.id))).toBeUndefined();
    });

    it('an unknown project still falls back to the workspace', async () => {
        await githubConnector('github', 'github.token', 'tok_workspace');
        expect(await token(refOf('prj_gone' as ProjectId))).toBe('tok_workspace');
    });

    it('the token is never written to the audit log — only the secret name', async () => {
        await githubConnector('github', 'github.token', 'tok_secret_value');
        expect(await token(refOf('prj_1' as ProjectId))).toBe('tok_secret_value');
        const { events } = await app.as(owner).actor(AuditActor, auditKey(WS)).list({});
        expect(events.some((e) => e.kind === 'secret.opened')).toBe(true);
        expect(JSON.stringify(events)).not.toContain('tok_secret_value');
    });
});

describe('connector helpers', () => {
    it('a provider connector by id, plugin or conduit connector id; its bearer, else its first secret', () => {
        expect(isProviderConnector({ id: 'github', pluginId: 'x' }, 'github')).toBe(true);
        expect(isProviderConnector({ id: 'gh', pluginId: 'github' }, 'github')).toBe(true);
        expect(isProviderConnector({ id: 'gh', pluginId: 'gh', connector: 'github' }, 'github')).toBe(true);
        expect(isProviderConnector({ id: 'gh', pluginId: 'gh' }, 'github')).toBe(false);
        expect(connectorSecretOf({ auth: { bearer: 'a' }, secrets: ['b'] })).toBe('a');
        expect(connectorSecretOf({ secrets: ['b'] })).toBe('b');
        expect(connectorSecretOf({})).toBeUndefined();
    });
});
