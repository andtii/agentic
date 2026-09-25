/**
 * Feature tools join sessions (#737; PRJ-06, PRJ-12): a project feature that declares `ui.tools` adds those tool
 * families to every session of the project — on the local path (the spec's config the API factory builds its tools and
 * policy from) and on the daemon path (the `OpenSpec`'s tools and policy grants) — under the agent's own tool policy: a
 * tool the agent denies stays denied. A family the build does not know is skipped, and the task's timeline says so.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enabledProjectFeatures, type AgentId, type EnvironmentId, type MachineId, type Principal, type ProjectFeatureManifest, type ProjectFeaturePlugin, type ProjectId, type ProjectRecord, type RuntimeId, type SessionId, type TaskId, type ToolGrant, type WorkspaceId } from '@agentic/core';
import { inMemoryEnvironment, inMemoryHarness, type InMemoryDaemon, type PlatformSeat } from '@agentic/daemon-protocol/testing';
import { anthropicApiPlugin, claudeCodePlugin } from '@agentic/runtimes';
import { allowAll } from '@sigx/ai-agent';
import { mockAgent } from '@sigx/ai-agent/testing';

import { AgentActor, agentKey } from '../../src/agent/index';
import { AuditActor } from '../../src/audit/index';
import { generateWorkspaceKek, importWorkspaceKek, workspaceKey } from '../../src/auth/index';
import { ChatPage, defineChatActor } from '../../src/chat/index';
import { defineMachineActor, machineKey, type MachineSocketPort } from '../../src/machine/index';
import { PairingDirectory } from '../../src/pairing/index';
import { defineRegistry } from '../../src/registry/index';
import { createToolCallPort, DEFAULT_TOOL_FAMILIES, defineRoutingActor, featureTools, PLAN_TOOL_NAMES, routingKey, skippedToolsNote, withFeatureTools, type RuntimeCatalogue, type ToolFamilies } from '../../src/routing/index';
import { defineSessionActor, type CommandSink, type SessionFactory, type SessionOpenSpec } from '../../src/session/index';
import { TaskActor, taskKey } from '../../src/task/index';
import { Workspace } from '../../src/workspace/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const E1 = 'env_1' as EnvironmentId;
const asMachine = (id: MachineId): Principal => ({ kind: 'machine', workspaceId: WS, machineId: id });
const IN_MEMORY_PLUGIN = { ...claudeCodePlugin, id: 'in-memory', name: 'In-memory' };
const runtimes: RuntimeCatalogue = { 'in-memory': { host: 'daemon' }, 'anthropic-api': { host: 'local', open: () => Promise.reject(new Error('not opened here')) } };

const PLANNER = 'agentic.project.planner';
const GHOSTLY = 'agentic.project.ghostly';
const base: ProjectFeatureManifest = {
    id: PLANNER,
    version: '1.0.0',
    kind: 'project-feature',
    name: 'Planner',
    description: 'A fake plan feature',
    capabilities: [],
    config: { type: 'object' },
    projectSettings: { type: 'object' },
    permissions: [],
    compat: { platform: '*', core: '*' },
    ui: { tools: ['plan'] }
};
/** A feature declaring the known `plan` family. */
const planner: ProjectFeaturePlugin = { manifest: base };
/** A feature declaring a family no build knows, beside `plan`. */
const ghostly: ProjectFeaturePlugin = { manifest: { ...base, id: GHOSTLY, name: 'Ghostly', ui: { tools: ['ghost', 'plan'] } } };

const PLAN = [...PLAN_TOOL_NAMES];

function projectOf(features: Record<string, Record<string, unknown>>): ProjectRecord {
    return { id: 'p1' as ProjectId, name: 'P', members: {}, folders: {}, connectors: [], features, createdAt: 0, updatedAt: 0 } as unknown as ProjectRecord;
}

describe('featureTools / withFeatureTools (#737)', () => {
    it("collects the enabled features' families as grants, once per tool, and reports an unknown family", () => {
        const families: ToolFamilies = { plan: [{ name: 'plan_list' }, { name: 'plan_add', mode: 'ask' }] };
        const project = projectOf({ [GHOSTLY]: {}, [PLANNER]: {} });
        expect(enabledProjectFeatures(project).length).toBe(2);
        const out = featureTools(project, { [PLANNER]: planner, [GHOSTLY]: ghostly }, families);
        expect(out.tools).toEqual([{ name: 'plan_list' }, { name: 'plan_add', mode: 'ask' }]);
        expect(out.skipped).toEqual([{ pluginId: GHOSTLY, family: 'ghost' }]);
        expect(skippedToolsNote(out.skipped)).toBe('warning: unknown tool family "ghost" (feature agentic.project.ghostly) skipped');
        expect(skippedToolsNote([])).toBeUndefined();
    });

    it('skips features this build does not ship, and features not enabled', () => {
        expect(featureTools(projectOf({ [PLANNER]: {} }), {}, DEFAULT_TOOL_FAMILIES)).toEqual({ tools: [], skipped: [] });
        expect(featureTools(projectOf({}), { [PLANNER]: planner }, DEFAULT_TOOL_FAMILIES)).toEqual({ tools: [], skipped: [] });
    });

    it("keeps the agent's own grant for a tool it already lists — a deny stays denied", () => {
        const config = { tools: [{ name: 'plan_add', mode: 'deny' }, { name: 'memory_search' }] as readonly ToolGrant[] };
        const joined = withFeatureTools(config, [{ name: 'plan_list' }, { name: 'plan_add' }]);
        expect(joined.tools).toEqual([{ name: 'plan_add', mode: 'deny' }, { name: 'memory_search' }, { name: 'plan_list' }]);
        expect(withFeatureTools(config, [])).toBe(config);
    });
});

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
    opens(key: string): Record<string, { tools?: string[]; system?: string; policy?: { grants: ToolGrant[] } }> {
        const out: Record<string, { tools?: string[]; system?: string; policy?: { grants: ToolGrant[] } }> = {};
        for (const t of this.sent.get(key) ?? []) {
            const f = JSON.parse(t) as { t: string; sessionId?: string; spec?: { tools?: string[]; system?: string; policy?: { grants: ToolGrant[] } } };
            if (f.t === 'session.open') out[f.sessionId!] = f.spec ?? {};
        }
        return out;
    }
}

const until = async (check: () => Promise<boolean> | boolean, what: string, timeoutMs = 4_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
};

let app: TestActorApp;
let sockets: FakeSockets;
let localSpecs: SessionOpenSpec[];
let Session: ReturnType<typeof defineSessionActor>;
let Machine: ReturnType<typeof defineMachineActor>;
let Routing: ReturnType<typeof defineRoutingActor>;
const Registry = defineRegistry({ kek: () => importWorkspaceKek(generateWorkspaceKek()), catalogue: [IN_MEMORY_PLUGIN, anthropicApiPlugin, base, ghostly.manifest] });
const daemons: InMemoryDaemon[] = [];

beforeEach(async () => {
    sockets = new FakeSockets();
    localSpecs = [];
    const agent = mockAgent({ respond: () => [{ text: 'done' }] });
    const factory: SessionFactory = async (runtime, c) => {
        if (runtime !== 'anthropic-api') return null;
        localSpecs.push(c.spec);
        const session = await agent.session({ policy: allowAll, signal: c.signal });
        return { session, agentId: agent.id, capabilities: agent.capabilities };
    };
    const sink: CommandSink = { send: (t, cmd) => app.as(owner).actor(Machine, machineKey(t.workspaceId, t.machineId)).sendCommand(t.sessionId, cmd) };
    Session = defineSessionActor({ factory, commands: sink });
    Routing = defineRoutingActor({ sessions: () => Session, machines: () => Machine, registry: () => Registry, runtimes, projectFeatures: { [PLANNER]: planner, [GHOSTLY]: ghostly } });
    Machine = defineMachineActor({ socket: sockets, sessions: () => Session, routing: () => Routing, tools: createToolCallPort({ routing: () => Routing, sessions: () => Session }) });
    const RoutedChat = defineChatActor({ routing: () => Routing });
    app = testActorApp([Routing, Session, Machine, TaskActor, AgentActor, Workspace, PairingDirectory, RoutedChat, ChatPage, Registry, AuditActor]);
    await app.start();
});

afterEach(async () => {
    for (const d of daemons.splice(0)) d.stop();
    await app.stop();
});

const routing = () => app.as(owner).actor(Routing, routingKey(WS));
const task = (id: string) => app.as(owner).actor(TaskActor, taskKey(WS, id as TaskId));
const machine = (id: MachineId, principal: Principal = owner) => app.as(principal).actor(Machine, machineKey(WS, id));
const session = (id: string) => app.as(owner).actor(Session, `${WS}:session:${id}`);
const workspace = () => app.as(owner).actor(Workspace, workspaceKey(WS));
const settled = (id: string) => until(async () => ['completed', 'failed', 'cancelled'].includes((await task(id).get()).status), `task ${id} to settle`);

async function agent(id: string, runtime: RuntimeId, tools: ToolGrant[] = []): Promise<AgentId> {
    const agentId = id as AgentId;
    await workspace().createAgent({ name: id });
    await app.as(owner).actor(AgentActor, agentKey(WS, agentId)).update({ name: id, instructions: 'Be brief.', tools, connectors: [], execution: { runtime, offlinePolicy: 'fail', ...(runtime === 'in-memory' ? { defaultEnvironmentId: E1 } : {}) } }, 'create');
    return agentId;
}

async function project(features: Record<string, Record<string, unknown>>): Promise<ProjectId> {
    return (await workspace().upsertProject({ name: 'Agentic', folders: {}, connectors: [], features })).id;
}

async function runTask(id: string, assignee: AgentId, projectId: ProjectId): Promise<void> {
    await task(id).create({ objective: 'do the thing', origin: { kind: 'external', clientId: 'c1' }, assignee, context: [], constraints: {}, projectId }, { owner: assignee });
    await routing().run(id as TaskId);
    await settled(id);
}

async function onlineMachine(): Promise<MachineId> {
    const { machineId, pairingCode } = await workspace().registerMachinePending({ name: 'laptop' });
    await machine(machineId).pair(pairingCode, { name: 'laptop' });
    const d = inMemoryHarness({ machineId, environments: [{ ...inMemoryEnvironment(machineId, E1), cwdRoots: ['/work'] }] }).start({ events: 2, heartbeatMs: 600_000 }) as InMemoryDaemon;
    daemons.push(d);
    const key = machineKey(WS, machineId);
    const seat = d.dial();
    sockets.seats.set(key, seat);
    sockets.connected.add(key);
    const asDaemon = machine(machineId, asMachine(machineId));
    void (async () => {
        try {
            for (;;) await asDaemon.socketMessage((await seat.next()) as string);
        } catch {
            // dropped
        }
    })();
    await until(async () => (await machine(machineId).get()).online, 'the machine to come online');
    return machineId;
}

describe('feature tools join sessions (#737)', () => {
    it('local path: a feature declaring plan adds the plan tools to the spec and its config, the agent\'s deny kept', async () => {
        const a = await agent('agent_api', 'anthropic-api' as RuntimeId, [{ name: 'memory_search' }, { name: 'plan_handoff', mode: 'deny' }]);
        const projectId = await project({ [PLANNER]: {} });
        await runTask('t1', a, projectId);
        expect((await task('t1').get()).status).toBe('completed');
        const spec = localSpecs.at(-1)!;
        expect(spec.tools).toEqual(['memory_search', ...PLAN.filter((n) => n !== 'plan_handoff')]);
        expect(spec.config.tools).toContainEqual({ name: 'plan_handoff', mode: 'deny' });
        expect(spec.config.tools.filter((g) => g.name === 'plan_handoff')).toHaveLength(1);
        expect(spec.config.tools).toContainEqual({ name: 'plan_claim' });
        // No warning: every family was known.
        expect((await task('t1').get()).transitions.map((t) => t.why).join(' | ')).not.toMatch(/unknown tool/);
    });

    it('daemon path: the OpenSpec carries the plan tools and grants; an unknown family is skipped with a warning on the timeline', async () => {
        const m1 = await onlineMachine();
        const a = await agent('agent_cli', 'in-memory' as RuntimeId);
        const projectId = await project({ [GHOSTLY]: {} });
        await runTask('t2', a, projectId);
        expect((await task('t2').get()).status).toBe('completed');
        const sessionId = (await task('t2').get()).sessionId as SessionId;
        const sent = sockets.opens(machineKey(WS, m1))[sessionId]!;
        expect(sent.tools).toEqual(PLAN);
        expect(sent.policy?.grants.map((g) => g.name)).toEqual(PLAN);
        expect(sent.system).toContain('plan_next');
        expect((await session(sessionId).get()).spec?.tools).toEqual(PLAN);
        const whys = (await task('t2').get()).transitions.map((t) => t.why ?? '');
        expect(whys.find((w) => w.includes('unknown tool family'))).toMatch(/"ghost" \(feature agentic\.project\.ghostly\)/);
    });

    it('a task outside any project gets no feature tools', async () => {
        const a = await agent('agent_api', 'anthropic-api' as RuntimeId, [{ name: 'memory_search' }]);
        await task('t3').create({ objective: 'do the thing', origin: { kind: 'external', clientId: 'c1' }, assignee: a, context: [], constraints: {} }, { owner: a });
        await routing().run('t3' as TaskId);
        await settled('t3');
        expect(localSpecs.at(-1)!.tools).toEqual(['memory_search']);
    });
});
