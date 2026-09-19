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
import { actorKey, CONNECTOR_CREDENTIALS_TOOL, type AgentId, type EnvironmentId, type FrozenAgentConfig, type MachineId, type Principal, type SessionId, type TaskId, type WorkspaceId } from '@agentic/core';
import { inMemoryEnvironment, inMemoryHarness, type InMemoryDaemon, type PlatformSeat } from '@agentic/daemon-protocol/testing';
import { mcpConnectorSetup } from '@agentic/mcp';
import { claudeCodePlugin } from '@agentic/runtimes';

import { AgentActor, agentKey } from '../../src/agent/index';
import { AuditActor, auditKey } from '../../src/audit/index';
import { generateWorkspaceKek, importWorkspaceKek, mintAgentPrincipal, workspaceKey } from '../../src/auth/index';
import { defineMachineActor, machineKey, parseMachineKey, ToolCallError, type MachineSocketPort, type ToolCallPort } from '../../src/machine/index';
import { PairingDirectory } from '../../src/pairing/index';
import { defineRegistry, registryKey, type GateConnector } from '../../src/registry/index';
import { createSessionFactory, createToolCallPort, daemonConnectors, defineRoutingActor, routingKey, type RuntimeCatalogue } from '../../src/routing/index';
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
