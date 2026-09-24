/**
 * `network:` grants are enforced (#642; PLG-04): `gate()` hands each ready connector its plugin's granted
 * `network:` hosts (`networkHosts`), and routing passes them to the app's opener as `allowedHosts` on every open —
 * local, daemon `tool.call` declaration and call — so the opener's fetch reaches those hosts only. A Streamable HTTP
 * connector whose own host is not granted is not opened, placed on a daemon's spec, or given credentials, and the
 * agent is told why, naming the scope. A stdio server is out of reach and unaffected. A gate answer recorded before
 * the allowlist (no `networkHosts`) opens as before.
 */
// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkspaceId } from '@agentic/core';
import { gmailConnectorPlugin } from '@agentic/connectors';
import { mcpConnector } from '@agentic/mcp';
import { anthropicApiPlugin } from '@agentic/runtimes';
import { defineTool, type AnyTool } from '@sigx/ai';

import { AuditActor } from '../../src/audit/index';
import { generateWorkspaceKek, importWorkspaceKek } from '../../src/auth/index';
import { defineRegistry, registryKey, type GateConnector } from '../../src/registry/index';
import { callPlatformConnector, connectorCredentials, ConnectorCredentialsError, daemonConnectors, openSessionConnectors, platformConnectorTools, type ConnectorOpenContext, type ConnectorOpenInput, type ConnectorOpener } from '../../src/routing/index';
import { Workspace } from '../../src/workspace/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const KEK = generateWorkspaceKek();
const SEARCH = 'gmail__search-messages';
const Registry = defineRegistry({ kek: () => importWorkspaceKek(KEK), catalogue: [anthropicApiPlugin, { manifest: gmailConnectorPlugin, enabledByDefault: false }] });

/** An opener that records what it was handed and serves one tool per connector. */
function recordingOpener() {
    const inputs: ConnectorOpenInput[] = [];
    const tool = (name: string): AnyTool =>
        defineTool({
            name,
            description: name,
            input: { '~standard': { version: 1, vendor: 't', validate: (v: unknown) => ({ value: v as Record<string, unknown> }) } },
            jsonSchema: { type: 'object', properties: {} },
            execute: async () => ({ ok: true })
        }) as AnyTool;
    const opener: ConnectorOpener = async (input) => {
        inputs.push(input);
        const name = input.kind === 'conduit' ? SEARCH : `${input.id}__ping`;
        return { tools: [tool(name)], toolNames: [name], close: async () => undefined };
    };
    return { opener, inputs };
}

const context: ConnectorOpenContext = { workspaceId: WS, principal: owner, secret: async () => undefined };
const gmail = (over: Partial<GateConnector> = {}): GateConnector => ({ id: 'gmail', state: 'ready', pluginId: 'gmail', transport: 'conduit', connector: 'gmail', account: 'acct_1', toolsGranted: true, ...over });
const acme = (over: Partial<GateConnector> = {}): GateConnector => ({ id: 'acme', state: 'ready', pluginId: 'acme', transport: 'streamable-http', url: 'https://acme.test/mcp?k=1', auth: { bearer: 'acme-token' }, toolsGranted: true, ...over });
const REVOKED = 'network permission revoked: network:acme.test is not granted (/plugins/acme)';

describe('the gate answer carries the granted network: hosts', () => {
    let app: TestActorApp;
    afterEach(() => app?.stop());

    it('every declared host while granted; a revoked one drops out; an MCP connector the same', async () => {
        app = testActorApp([Registry, AuditActor, Workspace]);
        await app.start();
        const registry = app.as(owner).actor(Registry, registryKey(WS));
        await registry.enable('gmail');
        await registry.putConnector({ id: 'gmail', pluginId: 'gmail', transport: 'conduit', connector: 'gmail', account: 'acct_1' });
        const hosts = async (id: string) => (await registry.gate({ runtime: 'anthropic-api', connectors: [id] })).connectors![0]!.networkHosts;
        expect([...(await hosts('gmail'))!].sort()).toEqual(['gmail.googleapis.com', 'oauth2.googleapis.com']);
        await registry.revoke('gmail', ['network:gmail.googleapis.com']);
        expect(await hosts('gmail')).toEqual(['oauth2.googleapis.com']);

        await registry.register(mcpConnector({ id: 'acme', name: 'Acme', transport: 'streamable-http', url: 'https://acme.test/mcp' }), { enabled: true, grant: 'declared' });
        await registry.putConnector({ id: 'acme', pluginId: 'acme', transport: 'streamable-http', url: 'https://acme.test/mcp' });
        expect(await hosts('acme')).toEqual(['acme.test']);
        await registry.revoke('acme', ['network:acme.test']);
        expect(await hosts('acme')).toEqual([]);
    });
});

describe('on the local path (openSessionConnectors)', () => {
    it('hands the opener each connector’s granted hosts as allowedHosts', async () => {
        const o = recordingOpener();
        const out = await openSessionConnectors({ connectors: [gmail({ networkHosts: ['oauth2.googleapis.com'] }), acme({ networkHosts: ['acme.test'] })], opener: o.opener, secret: async () => 'acme-token', context });
        expect(out.unavailable).toEqual([]);
        expect(o.inputs.find((i) => i.kind === 'conduit')?.allowedHosts).toEqual(['oauth2.googleapis.com']);
        expect(o.inputs.find((i) => i.kind === 'mcp')?.allowedHosts).toEqual(['acme.test']);
    });

    it('leaves out an MCP connector whose own host is revoked — unopened, no secret opened — and says why, naming only the scope', async () => {
        const o = recordingOpener();
        const secrets: string[] = [];
        const out = await openSessionConnectors({ connectors: [acme({ networkHosts: [] })], opener: o.opener, secret: async (name) => (secrets.push(name), 'acme-token'), context });
        expect(out.tools).toEqual([]);
        expect(out.unavailable).toEqual([{ id: 'acme', reason: REVOKED }]);
        expect(REVOKED).not.toContain('k=1');
        expect(o.inputs).toEqual([]);
        expect(secrets).toEqual([]);
    });

    it('a gate answer from before the allowlist opens as before, with no allowedHosts', async () => {
        const o = recordingOpener();
        await openSessionConnectors({ connectors: [gmail(), acme()], opener: o.opener, secret: async () => 'acme-token', context });
        expect(o.inputs).toHaveLength(2);
        for (const i of o.inputs) expect(i.allowedHosts).toBeUndefined();
    });
});

describe('on the daemon path', () => {
    it('daemonConnectors places no HTTP connector whose host is revoked; a stdio server is out of reach and placed', () => {
        const stdio: GateConnector = { id: 'local', state: 'ready', pluginId: 'local', transport: 'stdio', command: 'srv', toolsGranted: true, networkHosts: [] };
        const placed = daemonConnectors([acme({ networkHosts: ['other.test'] }), stdio], 'machine_1');
        expect(placed.connectors.map((c) => c.id)).toEqual(['local']);
        expect(placed.unavailable).toEqual([{ id: 'acme', reason: REVOKED }]);
    });

    it('connectorCredentials gives no credentials for an HTTP connector whose host is revoked', async () => {
        const opened: string[] = [];
        const refused = await connectorCredentials({ connectors: [acme({ networkHosts: [] })], connectorId: 'acme', secret: async (name) => (opened.push(name), 'acme-token') }).catch((e: unknown) => e);
        expect(refused).toBeInstanceOf(ConnectorCredentialsError);
        expect((refused as ConnectorCredentialsError).code).toBe('not-named');
        expect(opened).toEqual([]);
        await expect(connectorCredentials({ connectors: [acme({ networkHosts: ['acme.test'] })], connectorId: 'acme', secret: async () => 'acme-token' })).resolves.toEqual({ bearer: 'acme-token' });
    });

    it('platformConnectorTools and callPlatformConnector open a conduit connector behind its granted hosts', async () => {
        const o = recordingOpener();
        const connectors = [gmail({ networkHosts: ['oauth2.googleapis.com'] })];
        const declared = await platformConnectorTools({ connectors, opener: o.opener, context });
        expect(declared.connectors[0]?.tools.map((t) => t.name)).toEqual([SEARCH]);
        await expect(callPlatformConnector({ connectors, opener: o.opener, context, connectorId: 'gmail', tool: SEARCH, input: {}, callId: 'call_1' })).resolves.toEqual({ ok: true });
        expect(o.inputs.map((i) => i.allowedHosts)).toEqual([['oauth2.googleapis.com'], ['oauth2.googleapis.com']]);
    });

    it('a call the opener refuses for a host not granted keeps its code and message for the agent', async () => {
        const refusing: ConnectorOpener = async () => {
            const tool = defineTool({
                name: SEARCH,
                description: SEARCH,
                input: { '~standard': { version: 1, vendor: 't', validate: (v: unknown) => ({ value: v as Record<string, unknown> }) } },
                jsonSchema: { type: 'object', properties: {} },
                execute: async () => {
                    throw Object.assign(new Error('Permission denied: network:gmail.googleapis.com is not granted to this connector'), { name: 'ConnectorToolError', code: 'network_not_granted' });
                }
            }) as AnyTool;
            return { tools: [tool], toolNames: [SEARCH], close: async () => undefined };
        };
        const failure = await callPlatformConnector({ connectors: [gmail({ networkHosts: ['oauth2.googleapis.com'] })], opener: refusing, context, connectorId: 'gmail', tool: SEARCH, input: {}, callId: 'call_1' }).catch((e: unknown) => e);
        expect(failure).toMatchObject({ code: 'network_not_granted', message: expect.stringContaining('network:gmail.googleapis.com is not granted') });
    });
});
