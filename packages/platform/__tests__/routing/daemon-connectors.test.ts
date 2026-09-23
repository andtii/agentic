/**
 * An agent's MCP connectors on a daemon-hosted session (#280, architecture §9;
 * AGT-02, PLG-04, EXE-10): `Routing` places the ready ones on the daemon's
 * `OpenSpec` with secret NAMES only — the Machine keeps that spec and re-sends
 * it — and names the rest in the prompt; the daemon asks for the values over
 * its own `tool.call` (`CONNECTOR_CREDENTIALS_TOOL`), answered from the
 * Registry for a connector the calling session's gate named, and recorded
 * nowhere.
 */
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actorKey, CONNECTOR_CALL_TOOL, CONNECTOR_CREDENTIALS_TOOL, CONNECTOR_TOOLS_TOOL, type AgentId, type EnvironmentId, type FrozenAgentConfig, type MachineId, type Principal, type SessionId, type TaskId, type WorkspaceId } from '@agentic/core';
import { inMemoryEnvironment, inMemoryHarness, type InMemoryDaemon, type PlatformSeat } from '@agentic/daemon-protocol/testing';
import { gmailConnectorPlugin } from '@agentic/connectors';
import { mcpConnectorSetup } from '@agentic/mcp';
import { claudeCodePlugin } from '@agentic/runtimes';

import { AgentActor, agentKey } from '../../src/agent/index';
import { AuditActor, auditKey } from '../../src/audit/index';
import { generateWorkspaceKek, importWorkspaceKek, mintAgentPrincipal, workspaceKey } from '../../src/auth/index';
import { defineMachineActor, machineKey, parseMachineKey, ToolCallError, type MachineSocketPort, type ToolCallPort } from '../../src/machine/index';
import { PairingDirectory } from '../../src/pairing/index';
import { defineRegistry, registryKey, type GateConnector } from '../../src/registry/index';
import { createSessionFactory, createToolCallPort, daemonConnectors, defineRoutingActor, routingKey, type ConnectorOpenContext, type ConnectorOpener, type ConnectorOpenInput, type RuntimeCatalogue } from '../../src/routing/index';
import { defineTool, type AnyTool, type ToolAnnotations } from '@sigx/ai';
import { defineSessionActor, type CommandSink } from '../../src/session/index';
import { TaskActor, taskKey } from '../../src/task/index';
import { Workspace } from '../../src/workspace/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const KEK = generateWorkspaceKek();
const TOKEN = 'tok-acme-9f2c-SECRET';
const FILES_KEY = 'files-key-77e1-SECRET';
const E1 = 'env_1' as EnvironmentId;
/** The in-memory environment's runtime, as a runtime plugin the Registry lists — its sessions run on a machine. */
const IN_MEMORY_PLUGIN = { ...claudeCodePlugin, id: 'in-memory', name: 'In-memory' };

describe('daemonConnectors', () => {
    const ready = (over: Partial<GateConnector>): GateConnector => ({ id: 'acme', state: 'ready', pluginId: 'acme', transport: 'streamable-http', url: 'https://acme.test/mcp', auth: { bearer: 'acme.token' }, ...over });

    it('puts nothing of a conduit connector on the spec: a connected one runs on the platform over tool.call, an unconnected one is named with why (#534)', () => {
        const conduit = (over: Partial<GateConnector>) => ready({ id: 'gmail', pluginId: 'gmail', transport: 'conduit', url: undefined, auth: undefined, connector: 'gmail', account: 'acct_1', ...over });
        const placed = daemonConnectors([ready({}), conduit({}), conduit({ id: 'mail2', pluginId: 'mail2', account: undefined }), conduit({ id: 'odd', pluginId: 'odd', connector: undefined })], 'machine_1');
        expect(placed.connectors).toEqual([{ id: 'acme', transport: 'streamable-http', url: 'https://acme.test/mcp', auth: { bearer: 'acme.token' } }]);
        expect(placed.unavailable).toEqual([
            { id: 'mail2', reason: 'it is not connected yet (/plugins/mail2)' },
            { id: 'odd', reason: 'it names no conduit connector' }
        ]);
    });

    it('places every ready connector with secret names only, and names the rest with why', () => {
        const placed = daemonConnectors(
            [
                ready({}),
                ready({ id: 'files', pluginId: 'files', transport: 'stdio', url: undefined, command: 'files-mcp', args: ['--ro'], cwd: '/work/repo', machine: 'machine_1', auth: { env: { FILES_KEY: 'files.key' } } }),
                ready({ id: 'any', pluginId: 'any', transport: 'stdio', url: undefined, command: 'any-mcp', machine: '*', auth: undefined }),
                ready({ id: 'elsewhere', pluginId: 'elsewhere', transport: 'stdio', url: undefined, command: 'x', machine: 'machine_2' }),
                { id: 'off', state: 'disabled', pluginId: 'off' },
                { id: 'gone', state: 'missing' }
            ],
            'machine_1'
        );
        expect(placed.connectors).toEqual([
            { id: 'acme', transport: 'streamable-http', url: 'https://acme.test/mcp', auth: { bearer: 'acme.token' } },
            { id: 'files', transport: 'stdio', command: 'files-mcp', args: ['--ro'], cwd: '/work/repo', auth: { env: { FILES_KEY: 'files.key' } } },
            { id: 'any', transport: 'stdio', command: 'any-mcp' }
        ]);
        expect(placed.unavailable).toEqual([
            { id: 'elsewhere', reason: 'it runs on machine machine_2, not the one this session runs on' },
            { id: 'off', reason: 'its plugin is turned off (/plugins/off)' },
            { id: 'gone', reason: 'no such connector is set up in this workspace' }
        ]);
    });
});

let app: TestActorApp;
let port: ToolCallPort;
let Session: ReturnType<typeof defineSessionActor>;
let Routing: ReturnType<typeof defineRoutingActor>;
let Machine: ReturnType<typeof defineMachineActor>;
const Registry = defineRegistry({ kek: () => importWorkspaceKek(KEK), catalogue: [IN_MEMORY_PLUGIN] });
const runtimes: RuntimeCatalogue = { 'in-memory': { host: 'daemon' } };

const registry = () => app.as(owner).actor(Registry, registryKey(WS));
const audit = () => app.as(owner).actor(AuditActor, auditKey(WS)).list({}).then((page) => page.events);

/** acme over HTTP (bearer), files over stdio (an environment variable), both as the connector dialog stores them. */
async function addConnectors(options: { acmeSecret?: boolean } = {}): Promise<void> {
    for (const { manifest, connector } of [
        mcpConnectorSetup({ id: 'acme', name: 'Acme', transport: 'streamable-http', url: 'https://mcp.acme.test/mcp', secret: 'acme.token' }),
        mcpConnectorSetup({ id: 'files', name: 'Files', transport: 'stdio', command: 'files-mcp', args: ['--ro'], envSecrets: { FILES_KEY: 'files.key' } })
    ]) {
        await registry().register(manifest, { enabled: true, grant: 'declared' });
        await registry().putConnector(connector);
    }
    if (options.acmeSecret !== false) await registry().setSecret('acme.token', TOKEN);
    await registry().setSecret('files.key', FILES_KEY);
}

describe('the daemon’s credentials call', () => {
    const AGENT = 'agent_1' as AgentId;
    const SESSION = 'session_1' as SessionId;
    const principal = mintAgentPrincipal({ workspaceId: WS, agentId: AGENT, sessionId: SESSION });
    const config: FrozenAgentConfig = {
        agentId: AGENT,
        configVersion: 1,
        name: 'Ada',
        description: '',
        role: 'assistant',
        instructions: 'Be brief.',
        skills: [],
        tools: [],
        connectors: [{ id: 'acme' }, { id: 'files' }],
        approvalPolicy: [],
        memoryPolicy: { shared: [], autoLearn: 'off' },
        execution: { runtime: 'in-memory', limits: {}, offlinePolicy: 'fail' },
        collaborators: 'all'
    };
    const call = (input: unknown, as: Principal = principal) => port.call({ callId: 'call_1', sessionId: SESSION, tool: CONNECTOR_CREDENTIALS_TOOL, input }, as);
    const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => {
        try {
            await p;
            return undefined;
        } catch (e) {
            return e instanceof ToolCallError ? e.code : `not-a-tool-call-error: ${String(e)}`;
        }
    };

    async function begin(options: { acmeSecret?: boolean; registry?: boolean } = {}): Promise<void> {
        Session = defineSessionActor({ factory: () => null });
        Routing = defineRoutingActor({ sessions: () => Session, machines: () => Session });
        port = createToolCallPort({ routing: () => Routing, sessions: () => Session, ...(options.registry === false ? {} : { registry: () => Registry }) });
        app = testActorApp([Session, Routing, Registry, AuditActor, Workspace]);
        await app.start();
        await addConnectors(options);
        // The session's gate names acme and files — not "other", which exists but is not this agent's.
        await registry().register(mcpConnectorSetup({ id: 'other', name: 'Other', transport: 'streamable-http', url: 'https://other.test/mcp', secret: 'acme.token' }).manifest, { enabled: true, grant: 'declared' });
        const plugins = await registry().gate({ runtime: 'in-memory', connectors: ['acme', 'files'] });
        await app.as(owner).actor(Session, actorKey(WS, 'session', SESSION)).open({ agentId: AGENT, runtime: 'in-memory', machineId: 'machine_1' as MachineId, config, plugins });
    }
    afterEach(() => app?.stop());

    it('answers the values of a connector the session names, each opened under its plugin’s grant and audited, and keeps them nowhere', async () => {
        await begin();
        await expect(call({ connectorId: 'acme' })).resolves.toEqual({ bearer: TOKEN });
        await expect(call({ connectorId: 'files' })).resolves.toEqual({ env: { FILES_KEY } });
        const opened = (await audit()).filter((e) => e.kind === 'secret.opened');
        expect(opened.map((e) => e.data)).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'acme.token' }), expect.objectContaining({ name: 'files.key' })]));
        const session = await app.as(owner).actor(Session, actorKey(WS, 'session', SESSION)).get();
        const connectors = await registry().connectors();
        for (const kept of [session, connectors, await audit()]) {
            expect(JSON.stringify(kept)).not.toContain(TOKEN);
            expect(JSON.stringify(kept)).not.toContain(FILES_KEY);
        }
    });

    it('refuses a connector the session does not name, bad input, and a deployment without a Registry', async () => {
        await begin();
        expect(await codeOf(call({ connectorId: 'other' }))).toBe('forbidden');
        expect(await codeOf(call({ connectorId: 'nope' }))).toBe('forbidden');
        expect(await codeOf(call({}))).toBe('invalid');
        expect(await codeOf(call({ connectorId: 'acme' }, owner))).toBe('forbidden');
        await app.stop();
        await begin({ registry: false });
        expect(await codeOf(call({ connectorId: 'acme' }))).toBe('unsupported');
    });

    it('a secret not set: refused as invalid, naming it, and recorded on the connector once', async () => {
        await begin({ acmeSecret: false });
        await expect(call({ connectorId: 'acme' })).rejects.toThrow('its secret "acme.token" is not set (/plugins/acme)');
        const acme = (await registry().connectors()).find((c) => c.id === 'acme');
        expect(acme?.status).toMatchObject({ state: 'error', error: 'secret not set: its secret "acme.token" is not set (/plugins/acme)' });
    });
});

describe('platform-run connectors over the daemon’s tool.call (#534)', () => {
    const AGENT = 'agent_1' as AgentId;
    const SESSION = 'session_1' as SessionId;
    const principal = mintAgentPrincipal({ workspaceId: WS, agentId: AGENT, sessionId: SESSION });
    const CLIENT_SECRET = 'client-shh-5d1e-SECRET';
    const config: FrozenAgentConfig = {
        agentId: AGENT,
        configVersion: 1,
        name: 'Ada',
        description: '',
        role: 'assistant',
        instructions: 'Be brief.',
        skills: [],
        tools: [],
        connectors: [{ id: 'gmail' }, { id: 'acme' }],
        approvalPolicy: [],
        memoryPolicy: { shared: [], autoLearn: 'off' },
        execution: { runtime: 'in-memory', limits: {}, offlinePolicy: 'fail' },
        collaborators: 'all'
    };

    /** The app's opener, faked: what it was handed, and a conduit connector's tools — one that reads the plugin's secret and one that fails. */
    function fakeConduit(fail?: Error) {
        const opens: { input: ConnectorOpenInput; context?: ConnectorOpenContext }[] = [];
        const ran: { tool: string; input: unknown }[] = [];
        const tool = (name: string, annotations: ToolAnnotations | undefined, run: (input: Record<string, unknown>) => Promise<unknown>): AnyTool =>
            defineTool({
                name,
                description: `${name} described`,
                input: { '~standard': { version: 1, vendor: 't', validate: (v: unknown) => ({ value: v as Record<string, unknown> }) } },
                jsonSchema: { type: 'object', properties: { query: { type: 'string' } } },
                ...(annotations ? { annotations } : {}),
                execute: async (input: unknown) => {
                    ran.push({ tool: name, input });
                    return run(input as Record<string, unknown>);
                }
            }) as AnyTool;
        const opener: ConnectorOpener = async (input, context) => {
            opens.push({ input, ...(context ? { context } : {}) });
            if (input.kind !== 'conduit') throw new Error('not conduit');
            const secret = await context!.secret('gmail-client-secret', input.pluginId);
            return {
                tools: [
                    tool('gmail__search-messages', { readOnly: true }, async () => {
                        if (fail) throw fail;
                        return { messages: [{ id: 'm1' }] };
                    }),
                    tool('gmail__send-email', undefined, async () => {
                        throw new Error(`upstream said no to client ${secret}`);
                    })
                ],
                toolNames: ['gmail__search-messages', 'gmail__send-email'],
                close: async () => undefined
            };
        };
        return { opener, opens, ran };
    }

    let conduit: ReturnType<typeof fakeConduit>;
    const call = (tool: string, input: unknown, as: Principal = principal) => port.call({ callId: 'call_1', sessionId: SESSION, tool, input }, as);
    const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => {
        try {
            await p;
            return undefined;
        } catch (e) {
            return e instanceof ToolCallError ? e.code : `not-a-tool-call-error: ${String(e)}`;
        }
    };
    const RegistryWithGmail = defineRegistry({ kek: () => importWorkspaceKek(KEK), catalogue: [IN_MEMORY_PLUGIN, { manifest: gmailConnectorPlugin, enabledByDefault: false }] });

    async function begin(options: { fail?: Error; connected?: boolean; opener?: boolean } = {}): Promise<void> {
        conduit = fakeConduit(options.fail);
        Session = defineSessionActor({ factory: () => null });
        Routing = defineRoutingActor({ sessions: () => Session, machines: () => Session });
        port = createToolCallPort({ routing: () => Routing, sessions: () => Session, registry: () => RegistryWithGmail, ...(options.opener === false ? {} : { connectors: conduit.opener }) });
        app = testActorApp([Session, Routing, RegistryWithGmail, AuditActor, Workspace]);
        await app.start();
        const reg = app.as(owner).actor(RegistryWithGmail, registryKey(WS));
        await reg.enable('gmail');
        await reg.setSecret('gmail-client-secret', CLIENT_SECRET);
        await reg.putConnector({ id: 'gmail', pluginId: 'gmail', transport: 'conduit', connector: 'gmail', ...(options.connected === false ? {} : { account: 'acct_1' }) });
        // Another conduit connector in the workspace that this agent is not given.
        await reg.putConnector({ id: 'other', pluginId: 'gmail', transport: 'conduit', connector: 'gmail', account: 'acct_2' });
        const plugins = await reg.gate({ runtime: 'in-memory', connectors: ['gmail'] });
        await app.as(owner).actor(Session, actorKey(WS, 'session', SESSION)).open({ agentId: AGENT, runtime: 'in-memory', machineId: 'machine_1' as MachineId, config, plugins });
    }
    afterEach(() => app?.stop());

    it('answers the declarations of the session’s connected conduit connectors, opened as a local session opens them — no credential in the answer', async () => {
        await begin();
        const answer = await call(CONNECTOR_TOOLS_TOOL, {});
        expect(answer).toEqual({
            connectors: [
                {
                    id: 'gmail',
                    tools: [
                        { name: 'gmail__search-messages', description: 'gmail__search-messages described', inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, annotations: { readOnly: true } },
                        { name: 'gmail__send-email', description: 'gmail__send-email described', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }
                    ]
                }
            ],
            unavailable: []
        });
        expect(JSON.stringify(answer)).not.toContain(CLIENT_SECRET);
        expect(JSON.stringify(answer)).not.toContain('acct_1');
        // Ids only, the session's own agent principal, the plugin's secrets.
        expect(conduit.opens).toEqual([{ input: { kind: 'conduit', id: 'gmail', pluginId: 'gmail', connector: 'gmail', account: 'acct_1' }, context: expect.objectContaining({ workspaceId: WS, principal: expect.objectContaining({ kind: 'agent', sessionId: SESSION }) }) }]);
        // What the open found is recorded on the connector, as on the local path.
        expect((await app.as(owner).actor(RegistryWithGmail, registryKey(WS)).getConnector('gmail'))?.status.state).toBe('ok');
    });

    it('runs a call of a named connector on the platform and returns its result', async () => {
        await begin();
        await expect(call(CONNECTOR_CALL_TOOL, { connectorId: 'gmail', tool: 'gmail__search-messages', input: { query: 'is:unread' } })).resolves.toEqual({ messages: [{ id: 'm1' }] });
        expect(conduit.ran).toEqual([{ tool: 'gmail__search-messages', input: { query: 'is:unread' } }]);
    });

    it('refuses a connector the session does not name, a tool it does not have, bad input, a caller that is not an agent, and an unwired deployment', async () => {
        await begin();
        expect(await codeOf(call(CONNECTOR_CALL_TOOL, { connectorId: 'other', tool: 'gmail__search-messages', input: {} }))).toBe('forbidden');
        expect(await codeOf(call(CONNECTOR_CALL_TOOL, { connectorId: 'nope', tool: 'x', input: {} }))).toBe('forbidden');
        expect(await codeOf(call(CONNECTOR_CALL_TOOL, { connectorId: 'gmail', tool: 'gmail__nothing', input: {} }))).toBe('invalid');
        expect(await codeOf(call(CONNECTOR_CALL_TOOL, { connectorId: 'gmail' }))).toBe('invalid');
        expect(await codeOf(call(CONNECTOR_CALL_TOOL, { connectorId: 'gmail', tool: 'gmail__search-messages', input: {} }, owner))).toBe('forbidden');
        expect(await codeOf(call(CONNECTOR_TOOLS_TOOL, {}, owner))).toBe('forbidden');
        expect(conduit.ran).toEqual([]);
        await app.stop();
        await begin({ opener: false });
        await expect(call(CONNECTOR_TOOLS_TOOL, {})).resolves.toEqual({ connectors: [], unavailable: [] });
        expect(await codeOf(call(CONNECTOR_CALL_TOOL, { connectorId: 'gmail', tool: 'gmail__search-messages', input: {} }))).toBe('unsupported');
    });

    it('a connector the owner has not connected: no declarations, and a call is refused', async () => {
        await begin({ connected: false });
        await expect(call(CONNECTOR_TOOLS_TOOL, {})).resolves.toEqual({ connectors: [], unavailable: [] });
        expect(await codeOf(call(CONNECTOR_CALL_TOOL, { connectorId: 'gmail', tool: 'gmail__search-messages', input: {} }))).toBe('unsupported');
        expect(conduit.opens).toEqual([]);
    });

    it('an account that needs reconnecting is a tool error with its code; any other failure is scrubbed of the secrets opened for it', async () => {
        await begin({ fail: Object.assign(new Error('The Gmail account this connector uses needs to be reconnected.'), { name: 'ConnectorToolError', code: 'needs_reauth' }) });
        await expect(call(CONNECTOR_CALL_TOOL, { connectorId: 'gmail', tool: 'gmail__search-messages', input: {} })).rejects.toMatchObject({ code: 'needs_reauth', message: 'The Gmail account this connector uses needs to be reconnected.' });
        const failed = await call(CONNECTOR_CALL_TOOL, { connectorId: 'gmail', tool: 'gmail__send-email', input: {} }).catch((e: unknown) => e as ToolCallError);
        expect(failed).toMatchObject({ code: 'internal', message: 'gmail__send-email failed: upstream said no to client ***' });
    });
});

/** A fake socket layer bridged to `InMemoryDaemon` seats (the routing test's). */
class FakeSockets implements MachineSocketPort {
    readonly seats = new Map<string, PlatformSeat>();
    readonly sent = new Map<string, string[]>();
    connected = new Set<string>();
    send(key: string, text: string): boolean {
        if (!this.connected.has(key)) return false;
        (this.sent.get(key) ?? this.sent.set(key, []).get(key)!).push(text);
        this.seats.get(key)?.send(JSON.parse(text));
        return true;
    }
    close(key: string): void {
        this.seats.get(key)?.drop();
        this.seats.delete(key);
        this.connected.delete(key);
    }
}

describe('a connector on a daemon-hosted session', () => {
    let sockets: FakeSockets;
    const daemons: InMemoryDaemon[] = [];
    const until = async (check: () => Promise<boolean> | boolean, what: string): Promise<void> => {
        const deadline = Date.now() + 4_000;
        while (!(await check())) {
            if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
            await new Promise((r) => setTimeout(r, 5));
        }
    };

    beforeEach(async () => {
        sockets = new FakeSockets();
        const sink: CommandSink = { send: (t, cmd) => app.as(owner).actor(Machine, machineKey(t.workspaceId, t.machineId)).sendCommand(t.sessionId, cmd) };
        Session = defineSessionActor({ factory: createSessionFactory({ routing: () => Routing, sessions: () => Session, registry: () => Registry, runtimes }), commands: sink });
        Routing = defineRoutingActor({ sessions: () => Session, machines: () => Machine, registry: () => Registry, runtimes });
        Machine = defineMachineActor({ socket: sockets, sessions: () => Session, routing: () => Routing, tools: createToolCallPort({ routing: () => Routing, sessions: () => Session, registry: () => Registry }) });
        app = testActorApp([Routing, Session, Machine, TaskActor, AgentActor, Workspace, PairingDirectory, Registry, AuditActor]);
        await app.start();
    });
    afterEach(async () => {
        for (const d of daemons.splice(0)) d.stop();
        await app.stop();
    });

    async function pairAndConnect(): Promise<{ machineId: MachineId; key: string }> {
        const { machineId, pairingCode } = await app.as(owner).actor(Workspace, workspaceKey(WS)).registerMachinePending({ name: 'box' });
        await app.as(owner).actor(Machine, machineKey(WS, machineId)).pair(pairingCode, { name: 'box' });
        const d = inMemoryHarness({ machineId, environments: [inMemoryEnvironment(machineId, E1)] }).start({ events: 3, heartbeatMs: 600_000, tool: { name: CONNECTOR_CREDENTIALS_TOOL, input: { connectorId: 'acme' } } }) as InMemoryDaemon;
        daemons.push(d);
        const key = machineKey(WS, machineId);
        const asDaemon = app.as({ kind: 'machine', workspaceId: WS, machineId }).actor(Machine, key);
        const seat = d.dial();
        sockets.seats.set(key, seat);
        sockets.connected.add(key);
        void (async () => {
            try {
                for (;;) await asDaemon.socketMessage((await seat.next()) as string);
            } catch {
                // dropped
            }
        })();
        await until(async () => (await app.as(owner).actor(Machine, key).get()).online, 'the machine online');
        expect(parseMachineKey(key)?.machineId).toBe(machineId);
        return { machineId, key };
    }

    it('reaches the daemon on the spec with secret names only; the rest are named in the prompt; the Machine keeps no value', async () => {
        await addConnectors();
        const { key } = await pairAndConnect();
        const agentId = 'atlas' as AgentId;
        await app
            .as(owner)
            .actor(AgentActor, agentKey(WS, agentId))
            .update({ name: 'Atlas', instructions: 'Be brief.', tools: [{ name: 'task_report' }], connectors: [{ id: 'acme' }, { id: 'files' }, { id: 'gone' }], approvalPolicy: [], execution: { runtime: 'in-memory', defaultEnvironmentId: E1, offlinePolicy: 'fail' } }, 'create');
        await app.as(owner).actor(TaskActor, taskKey(WS, 't1' as TaskId)).create({ objective: 'use acme', origin: { kind: 'external', clientId: 'c1' }, assignee: agentId, context: [], constraints: {} }, { owner: agentId });
        await app.as(owner).actor(Routing, routingKey(WS)).run('t1' as TaskId);

        await until(() => (sockets.sent.get(key) ?? []).some((t) => JSON.parse(t).t === 'session.open'), 'session.open');
        const open = (sockets.sent.get(key) ?? []).map((t) => JSON.parse(t) as { t: string; spec?: { connectors?: unknown; system: string } }).find((f) => f.t === 'session.open')!;
        expect(open.spec!.connectors).toEqual([
            { id: 'acme', transport: 'streamable-http', url: 'https://mcp.acme.test/mcp', auth: { bearer: 'acme.token' } },
            { id: 'files', transport: 'stdio', command: 'files-mcp', args: ['--ro'], auth: { env: { FILES_KEY: 'files.key' } } }
        ]);
        expect(open.spec!.system).toContain('## Connectors not available');
        expect(open.spec!.system).toContain('- gone: no such connector is set up in this workspace');

        // The in-memory daemon asks for acme's values on its first turn, over tool.call; they travel only in the tool.result.
        await until(() => (sockets.sent.get(key) ?? []).some((t) => JSON.parse(t).t === 'tool.result'), 'tool.result');
        const result = (sockets.sent.get(key) ?? []).map((t) => JSON.parse(t) as { t: string; output?: unknown; error?: unknown }).find((f) => f.t === 'tool.result')!;
        expect(result).toMatchObject({ output: { bearer: TOKEN } });
        for (const kept of [await app.as(owner).actor(Machine, key).get(), await app.as(owner).actor(Routing, routingKey(WS)).get()]) {
            expect(JSON.stringify(kept)).not.toContain(TOKEN);
            expect(JSON.stringify(kept)).not.toContain(FILES_KEY);
        }
        expect(sockets.sent.get(key)!.filter((t) => t.includes(TOKEN))).toHaveLength(1);
    });
});
