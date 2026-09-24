/**
 * Connectors in the Registry (#240): `gate({ connectors })` answers for the
 * connectors an agent names in the same hop as its runtime — ready ones with
 * what a session needs to open them (secret NAMES only), the rest `disabled`
 * or `missing` — and `putConnector` holds a record to the secrets it binds.
 */
import type { WorkspaceId } from '@agentic/core';
import { mcpConnectorSetup } from '@agentic/mcp';
import { AuditActor } from '../../src/audit/index';
import { generateWorkspaceKek, importWorkspaceKek } from '../../src/auth/index';
import { defineRegistry, registryKey } from '../../src/registry/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const KEK = generateWorkspaceKek();
const Registry = defineRegistry({ kek: () => importWorkspaceKek(KEK) });

let app: TestActorApp;
beforeEach(async () => {
    app = testActorApp([Registry, AuditActor]);
    await app.start();
});
afterEach(() => app.stop());

const reg = () => app.as(owner).actor(Registry, registryKey(WS));

const acme = mcpConnectorSetup({ id: 'acme', name: 'Acme', transport: 'streamable-http', url: 'https://mcp.acme.test/mcp', secret: 'acme.token', headerSecrets: { 'X-Team': 'acme.team' } });

describe('gate({ connectors })', () => {
    it('answers for each connector asked, in order: ready with its binding, disabled, missing', async () => {
        await reg().register(acme.manifest, { enabled: true, grant: 'declared' });
        await reg().putConnector(acme.connector);
        const other = mcpConnectorSetup({ id: 'other', name: 'Other', transport: 'streamable-http', url: 'https://other.test/mcp' });
        await reg().register(other.manifest, { enabled: false, grant: 'declared' });
        await reg().putConnector(other.connector);

        const gate = await reg().gate({ connectors: ['acme', 'other', 'ghost', 'acme'] });
        expect(gate.connectors).toEqual([
            {
                id: 'acme',
                state: 'ready',
                pluginId: 'acme',
                transport: 'streamable-http',
                url: 'https://mcp.acme.test/mcp',
                auth: { bearer: 'acme.token', headers: { 'X-Team': 'acme.team' } },
                tools: [],
                status: { state: 'unknown' },
                toolPolicy: {},
                toolsGranted: true
            },
            { id: 'other', state: 'disabled', pluginId: 'other' },
            { id: 'ghost', state: 'missing' }
        ]);
    });

    it('the endpoint is the plugin config when the owner changed it there; nothing is asked → no connectors field', async () => {
        await reg().register(acme.manifest, { enabled: true, grant: 'declared' });
        await reg().putConnector(acme.connector);
        await reg().configure('acme', { url: 'https://mcp2.acme.test/mcp' });
        expect((await reg().gate({ connectors: ['acme'] })).connectors?.[0]?.url).toBe('https://mcp2.acme.test/mcp');
        expect(await reg().gate({})).not.toHaveProperty('connectors');
    });

    it('a record written before #240 (secrets, no auth) sends its first secret as the bearer', async () => {
        await reg().register(acme.manifest, { enabled: true, grant: 'declared' });
        await reg().putConnector({ id: 'acme', pluginId: 'acme', transport: 'streamable-http', url: 'https://mcp.acme.test/mcp', secrets: ['acme.token'] });
        expect((await reg().gate({ connectors: ['acme'] })).connectors?.[0]?.auth).toEqual({ bearer: 'acme.token' });
    });
});

describe('putConnector', () => {
    it('refuses a binding to a secret the record does not list', async () => {
        await reg().register(acme.manifest, { enabled: true, grant: 'declared' });
        await expect(reg().putConnector({ ...acme.connector, secrets: ['acme.token'] })).rejects.toThrow(/binds secret "acme.team"/);
    });
});

describe('a conduit connector (#530)', () => {
    /** A connector-kind manifest to hang the record on — the conduit manifests themselves arrive with #531. */
    const gmail = mcpConnectorSetup({ id: 'gmail', name: 'Gmail', transport: 'streamable-http', url: 'https://unused.test/mcp' }).manifest;

    it('round-trips through putConnector / connectors() / gate(): the connector and account ids, no endpoint, no secret names', async () => {
        await reg().register(gmail, { enabled: true, grant: 'declared' });
        await reg().putConnector({ id: 'gmail', pluginId: 'gmail', transport: 'conduit', connector: 'gmail', account: 'acct_1' });
        expect(await reg().connectors()).toEqual([expect.objectContaining({ id: 'gmail', pluginId: 'gmail', transport: 'conduit', connector: 'gmail', account: 'acct_1', tools: [], status: { state: 'unknown' } })]);
        // A plugin config url is an MCP setting; it never reaches a conduit connector.
        await reg().configure('gmail', { url: 'https://elsewhere.test/mcp' });
        expect((await reg().gate({ connectors: ['gmail'] })).connectors).toEqual([
            { id: 'gmail', state: 'ready', pluginId: 'gmail', transport: 'conduit', connector: 'gmail', account: 'acct_1', tools: [], status: { state: 'unknown' }, toolPolicy: {}, toolsGranted: true }
        ]);
    });

    it('before the owner connects, the gate answer has no account', async () => {
        await reg().register(gmail, { enabled: true, grant: 'declared' });
        await reg().putConnector({ id: 'gmail', pluginId: 'gmail', transport: 'conduit', connector: 'gmail' });
        expect((await reg().gate({ connectors: ['gmail'] })).connectors?.[0]).not.toHaveProperty('account');
    });

    it('needs a connector id and has no url, command, secrets or auth', async () => {
        await reg().register(gmail, { enabled: true, grant: 'declared' });
        await expect(reg().putConnector({ id: 'gmail', pluginId: 'gmail', transport: 'conduit' })).rejects.toThrow(/needs a connector id/);
        await expect(reg().putConnector({ id: 'gmail', pluginId: 'gmail', transport: 'conduit', connector: 'gmail', url: 'https://x.test/mcp' })).rejects.toThrow(/no url, command, secrets or auth/);
        await expect(reg().putConnector({ id: 'gmail', pluginId: 'gmail', transport: 'conduit', connector: 'gmail', command: 'x' })).rejects.toThrow(/no url, command, secrets or auth/);
        await expect(reg().putConnector({ id: 'gmail', pluginId: 'gmail', transport: 'conduit', connector: 'gmail', secrets: ['t'] })).rejects.toThrow(/no url, command, secrets or auth/);
        await expect(reg().putConnector({ id: 'gmail', pluginId: 'gmail', transport: 'conduit', connector: 'gmail', auth: { bearer: 't' } })).rejects.toThrow(/no url, command, secrets or auth/);
        expect(await reg().connectors()).toEqual([]);
    });
});
