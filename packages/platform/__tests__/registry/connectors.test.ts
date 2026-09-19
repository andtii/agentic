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
                status: { state: 'unknown' }
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
