/**
 * Sign-in readiness facts (#635; OPS-04, PLG-03): a conduit connector whose account needs signing in again, or an
 * MCP connector whose last check was refused with an auth error, reads `needs-sign-in` — that plugin only. The
 * live case runs over the real Registry and ConnectorAccounts actors, the same reads `useWorkspaceReadiness` makes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PluginManifest, WorkspaceId } from '@agentic/core';
import { gmailConnectorPlugin } from '@agentic/connectors';
import { ConnectorAccounts, connectorAccountsKey, defineRegistry, generateWorkspaceKek, importWorkspaceKek, registryKey, type ConnectorAccountSummary, type ConnectorRecord, type StoredAccount } from '@agentic/platform';
import { anthropicApiPlugin } from '@agentic/runtimes';
import { opsEnvironments, opsPluginFacts, opsPlugins } from '../../src/mock/ops';
import { isAuthError, readinessById, readinessFacts, signedOutPluginIds } from '../../src/pages/plugins/readiness';
import { WS, owner, startLive, type LiveHarness } from './live-harness';

type Rec = Pick<ConnectorRecord, 'pluginId' | 'transport' | 'account' | 'status'>;
const conduit = (pluginId: string, account?: string): Rec => ({ pluginId, transport: 'conduit', ...(account ? { account } : {}), status: { state: 'unknown' } });
const mcp = (pluginId: string, error?: string): Rec => ({ pluginId, transport: 'streamable-http', status: error ? { state: 'error', error } : { state: 'ok' } });
const summary = (id: string, status: ConnectorAccountSummary['status']): ConnectorAccountSummary => ({ id, connector: 'gmail', method: 'oauth', status, createdAt: 1, updatedAt: 1 });

describe('isAuthError', () => {
    it('matches a refused credential: HTTP 401/403 and the OAuth error words', () => {
        for (const m of [
            'MCP request "tools/list" to https://mcp.linear.app/mcp failed with HTTP 401',
            'MCP notification "initialized" to https://x/mcp failed with HTTP 403',
            'status 401',
            'Unauthorized',
            '403 Forbidden',
            'invalid_token: the access token expired',
            'invalid_grant',
            'needs reauth'
        ]) expect(isAuthError(m), m).toBe(true);
    });

    it('leaves every other failure alone', () => {
        for (const m of [undefined, '', 'MCP request "tools/list" to https://x/mcp failed with HTTP 404', 'failed with HTTP 500', 'HTTP 4010', 'fetch failed: connect ECONNREFUSED 127.0.0.1:4013', 'timed out after 10s', 'secret not set: github-token'])
            expect(isAuthError(m), String(m)).toBe(false);
    });
});

describe('signedOutPluginIds', () => {
    it('a conduit record whose account needs reauth (not one whose account is gone); an MCP record refused with an auth error', () => {
        const records = [conduit('gmail', 'a1'), conduit('outlook', 'a2'), conduit('drive', 'gone'), conduit('slack'), mcp('linear', 'failed with HTTP 401'), mcp('github-mcp', 'failed with HTTP 500'), mcp('notion')];
        const accounts = [summary('a1', 'needsReauth'), summary('a2', 'active')];
        expect(signedOutPluginIds(records, accounts).sort()).toEqual(['gmail', 'linear']);
    });

    it('accounts still loading sign no conduit record out', () => {
        expect(signedOutPluginIds([conduit('gmail', 'a1')], undefined)).toEqual([]);
    });

    it('an MCP record that is only unknown or ok is not signed out, whatever its old error said', () => {
        expect(signedOutPluginIds([{ ...mcp('linear'), status: { state: 'ok', error: 'HTTP 401' } }], [])).toEqual([]);
    });
});

describe('readinessFacts', () => {
    it('carries signedOut only when there is one', () => {
        expect(readinessFacts({ secretNames: [], hasKek: true }, [], []).signedOut).toBeUndefined();
        expect(readinessFacts({ secretNames: [], hasKek: true }, [], ['gmail']).signedOut).toEqual(['gmail']);
        expect(readinessFacts({ secretNames: [], hasKek: true, signedOut: ['linear'] }, []).signedOut).toEqual(['linear']);
    });

    it('mock mode: Linear is signed out, and nothing the mock workspace already shows changes', () => {
        const facts = readinessFacts(opsPluginFacts, opsEnvironments);
        expect(facts.signedOut).toEqual(['linear']);
        // The Linear row the connectors mock (#638) adds: a plain MCP connector with nothing else missing.
        const github = opsPlugins.find((p) => p.manifest.id === 'github-mcp')!;
        const linear = { ...github, manifest: { ...github.manifest, id: 'linear', name: 'Linear', secrets: [], permissions: [] } satisfies PluginManifest, grantedPermissions: [] };
        const byId = readinessById([...opsPlugins, linear], facts);
        expect(byId.linear?.status).toBe('needs-sign-in');
        expect(Object.entries(byId).filter(([, r]) => r.status === 'needs-sign-in').map(([id]) => id)).toEqual(['linear']);
    });
});

describe('needs-sign-in over the live reads', () => {
    const KEK = generateWorkspaceKek();
    const Registry = defineRegistry({ kek: () => importWorkspaceKek(KEK), catalogue: [anthropicApiPlugin, { manifest: gmailConnectorPlugin, enabledByDefault: false }] });
    let h: LiveHarness;
    beforeEach(async () => {
        h = await startLive(undefined, { actors: [Registry, ConnectorAccounts] });
    });
    afterEach(async () => {
        await h.stop();
    });
    const registry = () => h.app.as(owner).actor(Registry, registryKey(WS));
    const accounts = () => h.app.as(owner).actor(ConnectorAccounts, connectorAccountsKey(WS as WorkspaceId));
    const account = (status: StoredAccount['status']): StoredAccount => ({ id: 'acct_1', owner: WS, connector: 'gmail', method: 'oauth', status, credentials: 'sealed.NOT-A-TOKEN', displayName: 'owner@example.com', version: 1, createdAt: 1, updatedAt: 1 });

    const readiness = async () => {
        const overview = await registry().overview();
        const signedOut = signedOutPluginIds(await registry().connectors(), await accounts().accounts());
        return readinessById(overview.plugins, readinessFacts(overview, [], signedOut));
    };

    it('a needsReauth account yields needs-sign-in for that plugin only; renewed, it is ready', async () => {
        await registry().enable('gmail');
        await registry().setSecret('gmail-client-id', 'cid');
        await registry().setSecret('gmail-client-secret', 'cs');
        await accounts().createAccount(account('needsReauth'));
        await registry().putConnector({ id: 'gmail', pluginId: 'gmail', transport: 'conduit', connector: 'gmail', account: 'acct_1' });

        const before = await readiness();
        expect(before.gmail?.status).toBe('needs-sign-in');
        expect(Object.entries(before).filter(([, r]) => r.status === 'needs-sign-in').map(([id]) => id)).toEqual(['gmail']);

        expect(await accounts().updateAccount({ ...account('active'), version: 2 }, 1)).toBe(true);
        expect((await readiness()).gmail?.status).toBe('ready');
    }, 20_000);
});
