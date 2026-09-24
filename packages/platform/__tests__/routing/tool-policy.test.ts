/**
 * Sessions honour the workspace tool policy and the `tools:` grant (#636; OPS-02,
 * PLG-04, AC-12, AC-13): each ready connector's ask / deny tools (`gate()`'s
 * `toolPolicy`) become approval constraints on both paths — merged with the
 * ancestors' into the session's on the local path, into
 * `OpenSpec.policy.constraints` on the daemon path — so the stricter of the
 * workspace, the chain and the agent wins; and a connector
 * whose plugin's `tools:` scope is revoked is left out of every session with
 * "tools permission revoked".
 */
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actorKey, CONNECTOR_CALL_TOOL, CONNECTOR_TOOLS_TOOL, type AgentId, type ApprovalRule, type EnvironmentId, type FrozenAgentConfig, type MachineId, type OpenSpec, type SessionId, type TaskId, type ToolGrant, type WorkspaceId } from '@agentic/core';
import { gmailConnectorPlugin } from '@agentic/connectors';
import { inMemoryEnvironment, inMemoryHarness, type InMemoryDaemon, type PlatformSeat } from '@agentic/daemon-protocol/testing';
import { ANTHROPIC_API_KEY_SECRET, ANTHROPIC_API_PLUGIN_ID, anthropicApiPlugin, claudeCodePlugin, compilePolicy, constrainPolicy, sessionPolicy, sessionPolicyOf } from '@agentic/runtimes';
import { defineTool, type AnyTool, type ModelRequest } from '@sigx/ai';
import { mockModel, type MockModel } from '@sigx/ai/testing';
import { createGrants, type PolicyContext, type PolicyRequest } from '@sigx/ai-agent';

import { AgentActor, agentKey } from '../../src/agent/index';
import { AuditActor } from '../../src/audit/index';
import { generateWorkspaceKek, importWorkspaceKek, mintAgentPrincipal, workspaceKey } from '../../src/auth/index';
import { defineMachineActor, machineKey, ToolCallError, type MachineSocketPort } from '../../src/machine/index';
import { PairingDirectory } from '../../src/pairing/index';
import { defineRegistry, registryKey, type GateConnector } from '../../src/registry/index';
import {
    anthropicApiRuntime,
    createSessionFactory,
    createToolCallPort,
    daemonConnectors,
    defineRoutingActor,
    openSessionConnectors,
    routingKey,
    TOOLS_REVOKED_REASON,
    withWorkspaceRules,
    workspaceToolRules,
    type ConnectorOpener,
    type RuntimeCatalogue
} from '../../src/routing/index';
import { defineSessionActor, type CommandSink } from '../../src/session/index';
import { TaskActor, taskKey, type TaskView } from '../../src/task/index';
import { Workspace } from '../../src/workspace/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const KEK = generateWorkspaceKek();
const E1 = 'env_1' as EnvironmentId;
const SEND = 'gmail__send-email';
const SEARCH = 'gmail__search-messages';
const IN_MEMORY_PLUGIN = { ...claudeCodePlugin, id: 'in-memory', name: 'In-memory' };
const Registry = defineRegistry({ kek: () => importWorkspaceKek(KEK), catalogue: [anthropicApiPlugin, IN_MEMORY_PLUGIN, { manifest: gmailConnectorPlugin, enabledByDefault: false }] });

const context: PolicyContext = { sessionId: 's1', interactive: true, grants: createGrants(), signal: new AbortController().signal };
const permission = (toolName: string): PolicyRequest => ({ kind: 'permission', toolName, source: 'mcp', category: 'network' });

const until = async (check: () => Promise<boolean> | boolean, what: string): Promise<void> => {
    const deadline = Date.now() + 4_000;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
};

/** A conduit opener, faked: Gmail's two tools, every run recorded. */
function fakeGmail() {
    const ran: string[] = [];
    const tool = (name: string): AnyTool =>
        defineTool({
            name,
            description: `${name} described`,
            input: { '~standard': { version: 1, vendor: 't', validate: (v: unknown) => ({ value: v as Record<string, unknown> }) } },
            jsonSchema: { type: 'object', properties: {} },
            execute: async () => {
                ran.push(name);
                return { ok: true };
            }
        }) as AnyTool;
    const opener: ConnectorOpener = async (input) => {
        if (input.kind !== 'conduit') throw new Error('not conduit');
        return { tools: [tool(SEARCH), tool(SEND)], toolNames: [SEARCH, SEND], close: async () => undefined };
    };
    return { opener, ran };
}

let app: TestActorApp;
const registry = () => app.as(owner).actor(Registry, registryKey(WS));

/** Gmail enabled (its declared scopes granted), connected, its tools reported. */
async function addGmail(): Promise<void> {
    await registry().enable('gmail');
    await registry().putConnector({ id: 'gmail', pluginId: 'gmail', transport: 'conduit', connector: 'gmail', account: 'acct_1' });
    await registry().setConnectorStatus('gmail', { state: 'ok' }, [SEARCH, SEND]);
}

describe('workspaceToolRules', () => {
    const ready = (over: Partial<GateConnector>): GateConnector => ({ id: 'gmail', state: 'ready', pluginId: 'gmail', transport: 'conduit', toolsGranted: true, ...over });

    it('maps each ask / deny tool of a usable connector to a workspace:<plugin>:<tool> rule; allow, revoked and unready connectors add none', () => {
        const rules = workspaceToolRules([
            ready({ toolPolicy: { [SEND]: 'ask', gmail__archive: 'deny', gmail__odd: 'allow' as never } }),
            ready({ id: 'mail2', pluginId: 'gmail', toolPolicy: { [SEND]: 'ask' } }),
            ready({ id: 'acme', pluginId: 'acme', toolsGranted: false, toolPolicy: { acme__drop: 'deny' } }),
            { id: 'off', state: 'disabled', pluginId: 'off', toolPolicy: { off__x: 'deny' } },
            ready({ id: 'bare', pluginId: 'bare' })
        ]);
        expect(rules).toEqual([
            { id: `workspace:gmail:${SEND}`, match: { tools: [SEND] }, outcome: 'ask' },
            { id: 'workspace:gmail:gmail__archive', match: { tools: ['gmail__archive'] }, outcome: 'deny' }
        ]);
    });
});

describe('withWorkspaceRules: one first-match set that is the stricter of the ancestors and the workspace', () => {
    type Rule = ApprovalRule;
    const ws = (outcome: 'ask' | 'deny', tool = SEND): Rule => ({ id: `workspace:gmail:${tool}`, match: { tools: [tool] }, outcome });
    const request = (toolName: string, category: 'network' | 'read' = 'network'): PolicyRequest => ({ kind: 'permission', toolName, source: 'mcp', category });
    const agent = { approvalPolicy: [], tools: [{ name: SEND }, { name: SEARCH }] };
    const merged = (ancestors: readonly Rule[], workspace: readonly Rule[]) => sessionPolicy({ config: agent, approvalConstraints: withWorkspaceRules(ancestors, workspace) });

    it('a parent’s allow rule in the chain does not hide a workspace deny', async () => {
        const decision = await merged([{ id: 'parent-allow', match: { tools: [SEND] }, outcome: 'allow' }], [ws('deny')])(request(SEND), context);
        expect(decision).toMatchObject({ type: 'permission', outcome: 'deny', ruleId: `workspace:gmail:${SEND}` });
    });

    it('a workspace ask does not hide an ancestor deny, by tool or by category; it still tightens an ancestor allow', async () => {
        expect(await merged([{ id: 'parent-deny', match: { tools: [SEND] }, outcome: 'deny' }], [ws('ask')])(request(SEND), context)).toMatchObject({ outcome: 'deny', ruleId: 'parent-deny' });
        expect(await merged([{ id: 'no-network', match: { categories: ['network'] }, outcome: 'deny' }], [ws('ask')])(request(SEND), context)).toMatchObject({ outcome: 'deny', ruleId: 'no-network' });
        expect(await merged([{ id: 'parent-allow', match: {}, outcome: 'allow' }], [ws('ask')])(request(SEND), context)).toBe('ask');
    });

    it('leaves every other tool to the ancestors', async () => {
        expect(await merged([{ id: 'no-network', match: { categories: ['network'] }, outcome: 'deny' }], [ws('ask')])(request(SEARCH), context)).toMatchObject({ outcome: 'deny', ruleId: 'no-network' });
        expect(await merged([], [ws('deny')])(request(SEARCH), context)).toMatchObject({ outcome: 'allow' });
        expect(withWorkspaceRules([], [ws('ask')])).toEqual([ws('ask')]);
    });

    it('decides as the two sets compiled apart and combined stricter-wins, over every mix', async () => {
        const outcomes = ['allow', 'ask', 'deny'] as const;
        const shapes = (o: Rule['outcome']): Rule[] => [
            { id: `t-${o}`, match: { tools: [SEND] }, outcome: o },
            { id: `c-${o}`, match: { categories: ['network'] }, outcome: o },
            { id: `x-${o}`, match: { tools: [SEARCH] }, outcome: o },
            { id: `all-${o}`, match: {}, outcome: o }
        ];
        const singles = outcomes.flatMap(shapes);
        const chains: Rule[][] = [[], ...singles.map((r) => [r]), ...singles.flatMap((a) => singles.filter((b) => b.id !== a.id).map((b) => [a, b]))];
        for (const ancestors of chains) {
            for (const workspace of [[ws('ask')], [ws('deny')], [ws('ask'), ws('deny', SEARCH)]]) {
                const reference = constrainPolicy(sessionPolicy({ config: agent, ...(ancestors.length ? { approvalConstraints: ancestors } : {}) }), compilePolicy(workspace));
                const policy = merged(ancestors, workspace);
                for (const r of [request(SEND), request(SEND, 'read'), request(SEARCH), request(SEARCH, 'read')]) {
                    const want = await reference(r, context);
                    const got = await policy(r, context);
                    const outcome = (d: typeof want) => (d === 'ask' ? 'ask' : d && d.type === 'permission' ? d.outcome : String(d));
                    expect(outcome(got), `${JSON.stringify(ancestors)} + ${JSON.stringify(workspace)} on ${r.toolName}/${r.category}`).toBe(outcome(want));
                }
            }
        }
    });
});

describe('a revoked tools: grant, below the session', () => {
    const conduit: GateConnector = { id: 'gmail', state: 'ready', pluginId: 'gmail', transport: 'conduit', connector: 'gmail', account: 'acct_1', toolsGranted: false };

    it('openSessionConnectors leaves the connector out, unopened, and says why', async () => {
        const gmail = fakeGmail();
        let opened = 0;
        const out = await openSessionConnectors({ connectors: [conduit], opener: async (i, c) => (opened++, gmail.opener(i, c)), secret: async () => undefined });
        expect(out.tools).toEqual([]);
        expect(out.unavailable).toEqual([{ id: 'gmail', reason: TOOLS_REVOKED_REASON }]);
        expect(opened).toBe(0);
    });

    it('daemonConnectors places nothing of it and says why, for any transport', () => {
        const http: GateConnector = { id: 'acme', state: 'ready', pluginId: 'acme', transport: 'streamable-http', url: 'https://acme.test/mcp', toolsGranted: false };
        const placed = daemonConnectors([conduit, http], 'machine_1');
        expect(placed.connectors).toEqual([]);
        expect(placed.unavailable).toEqual([
            { id: 'gmail', reason: TOOLS_REVOKED_REASON },
            { id: 'acme', reason: TOOLS_REVOKED_REASON }
        ]);
    });
});

describe('on the local path', () => {
    let model: MockModel;
    let gmail: ReturnType<typeof fakeGmail>;
    let Session: ReturnType<typeof defineSessionActor>;
    let Routing: ReturnType<typeof defineRoutingActor>;

    const hasTool = (req: ModelRequest, name: string) => !!req.tools?.some((t) => t.name === name);
    const hasToolResult = (req: ModelRequest) => req.messages.some((m) => m.role === 'tool');
    const task = (id: string) => app.as(owner).actor(TaskActor, taskKey(WS, id as TaskId));
    const session = (id: string) => app.as(owner).actor(Session, actorKey(WS, 'session', id));

    beforeEach(async () => {
        gmail = fakeGmail();
        // Sends an email once when the session has the tool, then answers.
        model = mockModel({ modelId: 'claude-test', respond: (req) => (hasTool(req, SEND) && !hasToolResult(req) ? { toolCalls: [{ name: SEND, input: {}, id: 'c1' }] } : { text: 'done' }) });
        const runtimes: RuntimeCatalogue = { [ANTHROPIC_API_PLUGIN_ID]: anthropicApiRuntime({ routing: () => Routing, sessions: () => Session, model, connectors: gmail.opener }) };
        Session = defineSessionActor({ factory: createSessionFactory({ routing: () => Routing, sessions: () => Session, registry: () => Registry, runtimes }) });
        Routing = defineRoutingActor({ sessions: () => Session, machines: () => Session, registry: () => Registry, runtimes });
        app = testActorApp([Routing, Session, TaskActor, AgentActor, Workspace, Registry, AuditActor]);
        await app.start();
        await registry().setSecret(ANTHROPIC_API_KEY_SECRET, 'sk-ant-test');
        await addGmail();
    });
    afterEach(() => app?.stop());

    async function run(id: string, tools: readonly ToolGrant[]): Promise<TaskView> {
        const agentId = 'atlas' as AgentId;
        await app
            .as(owner)
            .actor(AgentActor, agentKey(WS, agentId))
            .update({ name: 'Atlas', instructions: 'Be brief.', tools: [{ name: 'task_report' }, ...tools], connectors: [{ id: 'gmail' }], approvalPolicy: [], execution: { runtime: 'anthropic-api', offlinePolicy: 'fail' } }, 'create');
        await task(id).create({ objective: 'send the mail', origin: { kind: 'external', clientId: 'c1' }, assignee: agentId, context: [], constraints: {} }, { owner: agentId });
        return app.as(owner).actor(Routing, routingKey(WS)).run(id as TaskId);
    }
    const settled = (id: string) => until(async () => ['completed', 'failed', 'cancelled'].includes((await task(id).get()).status), `task ${id} to settle`);

    it('with the workspace allowing it, an agent allow runs the tool (the control)', async () => {
        await registry().setToolPolicy('gmail', SEND, 'allow');
        await run('t1', [{ name: SEND, mode: 'allow' }]);
        await settled('t1');
        expect((await task('t1').get()).status).toBe('completed');
        expect(gmail.ran).toEqual([SEND]);
    });

    it('a workspace deny on gmail__send-email wins over an agent allow', async () => {
        await registry().setToolPolicy('gmail', SEND, 'deny');
        await run('t1', [{ name: SEND, mode: 'allow' }]);
        await settled('t1');
        expect((await task('t1').get()).status).toBe('completed');
        expect(gmail.ran).toEqual([]);
    });

    it('a workspace ask plus an agent deny gives deny: no request is raised, the tool never runs', async () => {
        await registry().setToolPolicy('gmail', SEND, 'ask');
        await run('t1', [{ name: SEND, mode: 'deny' }]);
        await settled('t1');
        expect((await task('t1').get()).status).toBe('completed');
        expect((await session((await task('t1').get()).sessionId!).get()).openRequests).toEqual([]);
        expect(gmail.ran).toEqual([]);
    });

    it('a workspace ask tightens an agent allow into the approval flow', async () => {
        await registry().setToolPolicy('gmail', SEND, 'ask');
        await run('t1', [{ name: SEND, mode: 'allow' }]);
        const sessionId = (await task('t1').get()).sessionId!;
        await until(async () => (await session(sessionId).get()).status === 'awaiting', 'the approval request');
        expect(gmail.ran).toEqual([]);
    });

    it('revoking tools:gmail means a new session has no Gmail tools, and the reason is in its prompt', async () => {
        await registry().setToolPolicy('gmail', SEND, 'allow');
        await registry().revoke('gmail', ['tools:gmail']);
        await run('t1', [{ name: SEND, mode: 'allow' }]);
        await settled('t1');
        expect((await task('t1').get()).status).toBe('completed');
        expect(model.requests.length).toBeGreaterThan(0);
        expect(model.requests.every((r) => !hasTool(r, SEND) && !hasTool(r, SEARCH))).toBe(true);
        expect(model.requests[0]!.system).toContain(`- gmail: ${TOOLS_REVOKED_REASON}`);
        expect(gmail.ran).toEqual([]);
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

describe('on the daemon path', () => {
    const runtimes: RuntimeCatalogue = { 'in-memory': { host: 'daemon' } };
    let sockets: FakeSockets;
    let Session: ReturnType<typeof defineSessionActor>;
    let Routing: ReturnType<typeof defineRoutingActor>;
    let Machine: ReturnType<typeof defineMachineActor>;
    const daemons: InMemoryDaemon[] = [];

    beforeEach(async () => {
        sockets = new FakeSockets();
        const sink: CommandSink = { send: (t, cmd) => app.as(owner).actor(Machine, machineKey(t.workspaceId, t.machineId)).sendCommand(t.sessionId, cmd) };
        Session = defineSessionActor({ factory: createSessionFactory({ routing: () => Routing, sessions: () => Session, registry: () => Registry, runtimes }), commands: sink });
        Routing = defineRoutingActor({ sessions: () => Session, machines: () => Machine, registry: () => Registry, runtimes });
        Machine = defineMachineActor({ socket: sockets, sessions: () => Session, routing: () => Routing, tools: createToolCallPort({ routing: () => Routing, sessions: () => Session, registry: () => Registry }) });
        app = testActorApp([Routing, Session, Machine, TaskActor, AgentActor, Workspace, PairingDirectory, Registry, AuditActor]);
        await app.start();
        await addGmail();
    });
    afterEach(async () => {
        for (const d of daemons.splice(0)) d.stop();
        await app.stop();
    });

    async function pairAndConnect(): Promise<string> {
        const { machineId, pairingCode } = await app.as(owner).actor(Workspace, workspaceKey(WS)).registerMachinePending({ name: 'box' });
        await app.as(owner).actor(Machine, machineKey(WS, machineId)).pair(pairingCode, { name: 'box' });
        const d = inMemoryHarness({ machineId, environments: [inMemoryEnvironment(machineId, E1)] }).start({ events: 3, heartbeatMs: 600_000 }) as InMemoryDaemon;
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
        return key;
    }

    /** Runs a task for an agent with `tools`, and returns the `session.open` spec the daemon got. */
    async function openSpec(key: string, tools: readonly ToolGrant[]): Promise<OpenSpec> {
        const agentId = 'atlas' as AgentId;
        await app
            .as(owner)
            .actor(AgentActor, agentKey(WS, agentId))
            .update({ name: 'Atlas', instructions: 'Be brief.', tools: [{ name: 'task_report' }, ...tools], connectors: [{ id: 'gmail' }], approvalPolicy: [], execution: { runtime: 'in-memory', defaultEnvironmentId: E1, offlinePolicy: 'fail' } }, 'create');
        await app.as(owner).actor(TaskActor, taskKey(WS, 't1' as TaskId)).create({ objective: 'send the mail', origin: { kind: 'external', clientId: 'c1' }, assignee: agentId, context: [], constraints: {} }, { owner: agentId });
        await app.as(owner).actor(Routing, routingKey(WS)).run('t1' as TaskId);
        await until(() => (sockets.sent.get(key) ?? []).some((t) => JSON.parse(t).t === 'session.open'), 'session.open');
        return (sockets.sent.get(key) ?? []).map((t) => JSON.parse(t) as { t: string; spec?: OpenSpec }).find((f) => f.t === 'session.open')!.spec!;
    }

    it('a workspace deny on gmail__send-email travels as a constraint and wins over an agent allow', async () => {
        await registry().setToolPolicy('gmail', SEND, 'deny');
        const spec = await openSpec(await pairAndConnect(), [{ name: SEND, mode: 'allow' }]);
        expect(spec.policy!.constraints).toContainEqual({ id: `workspace:gmail:${SEND}`, match: { tools: [SEND] }, outcome: 'deny' });
        expect(await sessionPolicyOf(spec.policy!)(permission(SEND), context)).toMatchObject({ type: 'permission', outcome: 'deny', ruleId: `workspace:gmail:${SEND}` });
        expect(await sessionPolicyOf(spec.policy!)(permission(SEARCH), context)).toMatchObject({ outcome: 'allow' });
    });

    it('a workspace ask plus an agent deny gives deny', async () => {
        await registry().setToolPolicy('gmail', SEND, 'ask');
        const spec = await openSpec(await pairAndConnect(), [{ name: SEND, mode: 'deny' }]);
        expect(spec.policy!.constraints).toContainEqual({ id: `workspace:gmail:${SEND}`, match: { tools: [SEND] }, outcome: 'ask' });
        expect(await sessionPolicyOf(spec.policy!)(permission(SEND), context)).toMatchObject({ type: 'permission', outcome: 'deny' });
    });

    it('revoking tools:gmail names it unavailable in the prompt, and puts no workspace rule of it on the spec', async () => {
        await registry().setToolPolicy('gmail', SEND, 'deny');
        await registry().revoke('gmail', ['tools:gmail']);
        const spec = await openSpec(await pairAndConnect(), [{ name: SEND, mode: 'allow' }]);
        expect(spec.system).toContain(`- gmail: ${TOOLS_REVOKED_REASON}`);
        expect(spec.connectors ?? []).toEqual([]);
        expect(spec.policy!.constraints ?? []).toEqual([]);
    });
});

describe('a revoked tools: grant, over the daemon’s tool.call', () => {
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
        connectors: [{ id: 'gmail' }],
        approvalPolicy: [],
        memoryPolicy: { shared: [], autoLearn: 'off' },
        execution: { runtime: 'in-memory', limits: {}, offlinePolicy: 'fail' },
        collaborators: 'all'
    };
    afterEach(() => app?.stop());

    it('declares no Gmail tools to a new session and refuses a call of one', async () => {
        const gmail = fakeGmail();
        const Session = defineSessionActor({ factory: () => null });
        const Routing = defineRoutingActor({ sessions: () => Session, machines: () => Session });
        const port = createToolCallPort({ routing: () => Routing, sessions: () => Session, registry: () => Registry, connectors: gmail.opener });
        app = testActorApp([Session, Routing, Registry, AuditActor, Workspace]);
        await app.start();
        await addGmail();
        await registry().revoke('gmail', ['tools:gmail']);
        const plugins = await registry().gate({ runtime: 'in-memory', connectors: ['gmail'] });
        expect(plugins.connectors![0]).toMatchObject({ state: 'ready', toolsGranted: false });
        await app.as(owner).actor(Session, actorKey(WS, 'session', SESSION)).open({ agentId: AGENT, runtime: 'in-memory', machineId: 'machine_1' as MachineId, config, plugins });
        const call = (tool: string, input: unknown) => port.call({ callId: 'call_1', sessionId: SESSION, tool, input }, principal);
        await expect(call(CONNECTOR_TOOLS_TOOL, {})).resolves.toEqual({ connectors: [], unavailable: [] });
        const refused = await call(CONNECTOR_CALL_TOOL, { connectorId: 'gmail', tool: SEND, input: {} }).catch((e: unknown) => e);
        expect(refused).toBeInstanceOf(ToolCallError);
        expect((refused as ToolCallError).code).toBe('forbidden');
        expect(gmail.ran).toEqual([]);
    });
});
