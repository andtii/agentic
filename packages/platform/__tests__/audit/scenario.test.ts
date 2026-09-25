/**
 * The audit trail end to end (OPS-03, COL-09, AGT-06): a scripted scenario
 * over `mockAgent` through the real Routing + Session + Task actors (plus
 * Agent, Machine, Registry, Workspace) with the Audit actor registered, and
 * every emitter one-way. Each listed action kind must appear EXACTLY once
 * per occurrence, `list` must filter and page, and the log must survive a
 * fresh host over the same storage. Offline and deterministic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actorKey, type AgentId, type EnvironmentId, type MachineId, type OfflinePolicy, type Principal, type RuntimeId, type SessionId, type TaskContract, type TaskId, type WorkspaceId } from '@agentic/core';
import { inMemoryEnvironment, inMemoryHarness, type InMemoryDaemon, type PlatformSeat } from '@agentic/daemon-protocol/testing';
import type { Policy } from '@sigx/ai-agent';
import { mockAgent, type MockAgent } from '@sigx/ai-agent/testing';

import { AgentActor, agentKey } from '../../src/agent/index';
import { AuditActor, auditKey, type AuditEvent, type AuditKind } from '../../src/audit/index';
import { generateWorkspaceKek, importWorkspaceKek, workspaceKey } from '../../src/auth/index';
import { defineMachineActor, machineKey, parseMachineKey, type MachineSocketPort } from '../../src/machine/index';
import { PairingDirectory } from '../../src/pairing/index';
import { defineRegistry, registryKey } from '../../src/registry/index';
import { createToolCallPort, defineRoutingActor, routingKey } from '../../src/routing/index';
import { defineSessionActor, type CommandSink, type SessionFactory } from '../../src/session/index';
import { TaskActor, taskKey, type TaskView } from '../../src/task/index';
import { Workspace } from '../../src/workspace/index';
import { elevatedPrincipal, memoryStorage, recordingStorage, testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
/** The owner beside a live elevation (#355): what revoking takes. */
const elevated = elevatedPrincipal('u1');
const E1 = 'env_1' as EnvironmentId;
const asMachine = (id: MachineId): Principal => ({ kind: 'machine', workspaceId: WS, machineId: id });

class FakeSockets implements MachineSocketPort {
    readonly seats = new Map<string, PlatformSeat>();
    connected = new Set<string>();
    send(key: string, text: string): boolean {
        if (!this.connected.has(key)) return false;
        this.seats.get(key)?.send(JSON.parse(text));
        return true;
    }
    close(key: string): void {
        this.seats.get(key)?.drop();
        this.seats.delete(key);
        this.connected.delete(key);
    }
}

const until = async (check: () => Promise<boolean> | boolean, what: string, timeoutMs = 4_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
};

/** Every permission is a question for the user; everything else has no opinion. */
const askForPermissions: Policy = (request) => (request.kind === 'permission' ? 'ask' : undefined);

/** The `anthropic-api` runtime: `approve` runs a tool the policy asks about, anything else echoes. */
function scriptedAgent(): MockAgent {
    return mockAgent({
        respond: (input) => {
            const text = input.map((p) => (p.type === 'text' ? p.text : '')).join('');
            if (text.startsWith('approve')) return [{ tool: { name: 'shell', input: { cmd: 'ls' }, output: 'ok' } }, { text: 'ran it' }];
            return [{ text: `echo: ${text}` }];
        }
    });
}

function localFactory(agent: MockAgent): SessionFactory {
    return async (runtime, c) => {
        if (runtime !== 'anthropic-api') return null;
        const session = await agent.session({ policy: askForPermissions, signal: c.signal, ...(c.resume ? { resume: c.resume } : {}) });
        return { session, agentId: agent.id, capabilities: agent.capabilities };
    };
}

const Registry = defineRegistry({ kek: () => importWorkspaceKek(generateWorkspaceKek()) });

let app: TestActorApp;
let storage: ReturnType<typeof recordingStorage>;
let sockets: FakeSockets;
let Session: ReturnType<typeof defineSessionActor>;
let Machine: ReturnType<typeof defineMachineActor>;
let Routing: ReturnType<typeof defineRoutingActor>;
const daemons: InMemoryDaemon[] = [];

function actors() {
    return [Routing, Session, Machine, TaskActor, AgentActor, Workspace, PairingDirectory, Registry, AuditActor];
}

beforeEach(async () => {
    storage = recordingStorage(memoryStorage());
    sockets = new FakeSockets();
    const sink: CommandSink = { send: (t, cmd) => app.as(owner).actor(Machine, machineKey(t.workspaceId, t.machineId)).sendCommand(t.sessionId, cmd) };
    Session = defineSessionActor({ factory: localFactory(scriptedAgent()), commands: sink });
    Routing = defineRoutingActor({ sessions: () => Session, machines: () => Machine });
    Machine = defineMachineActor({ socket: sockets, sessions: () => Session, routing: () => Routing, tools: createToolCallPort({ routing: () => Routing, sessions: () => Session }) });
    app = testActorApp(actors(), { storage });
    await app.start();
});

afterEach(async () => {
    for (const d of daemons.splice(0)) d.stop();
    await app.stop();
});

const routing = () => app.as(owner).actor(Routing, routingKey(WS));
const task = (id: string) => app.as(owner).actor(TaskActor, taskKey(WS, id as TaskId));
const machine = (id: MachineId, principal: Principal = owner) => app.as(principal).actor(Machine, machineKey(WS, id));
const session = (id: string) => app.as(owner).actor(Session, actorKey(WS, 'session', id));
const registry = () => app.as(owner).actor(Registry, registryKey(WS));
const audit = () => app.as(owner).actor(AuditActor, auditKey(WS));

async function agent(id: string, execution: { runtime: RuntimeId; defaultEnvironmentId?: EnvironmentId; offlinePolicy?: OfflinePolicy }): Promise<AgentId> {
    const agentId = id as AgentId;
    await app.as(owner).actor(AgentActor, agentKey(WS, agentId)).update({ name: id, instructions: 'Be brief.', tools: [{ name: 'task_report' }], execution: { offlinePolicy: 'fail', ...execution } }, 'create');
    return agentId;
}

async function createTask(id: string, assignee: AgentId, objective = 'do the thing', extra: Partial<TaskContract> = {}): Promise<TaskView> {
    return task(id).create({ objective, origin: { kind: 'external', clientId: 'c1' }, assignee, context: [], constraints: {}, ...extra }, { owner: assignee });
}

async function pairMachine(name: string): Promise<MachineId> {
    const { machineId, pairingCode } = await app.as(owner).actor(Workspace, workspaceKey(WS)).registerMachinePending({ name });
    await machine(machineId).pair(pairingCode, { name });
    return machineId;
}

function connect(machineId: MachineId, d: InMemoryDaemon): PlatformSeat {
    const key = machineKey(WS, machineId);
    const ids = parseMachineKey(key)!;
    const seat = d.dial();
    sockets.seats.set(key, seat);
    sockets.connected.add(key);
    const asDaemon = machine(ids.machineId, asMachine(ids.machineId));
    void (async () => {
        try {
            for (;;) await asDaemon.socketMessage((await seat.next()) as string);
        } catch {
            // dropped
        }
        if (sockets.seats.get(key) === seat) {
            sockets.seats.delete(key);
            sockets.connected.delete(key);
            await asDaemon.socketClosed().catch(() => {});
        }
    })();
    return seat;
}

const online = (id: MachineId, is = true) => until(async () => (await machine(id).get()).online === is, `${id} ${is ? 'online' : 'offline'}`);
const settled = (id: string) => until(async () => ['completed', 'failed', 'cancelled'].includes((await task(id).get()).status), `task ${id} to settle`);

/** A paired machine that reported `E1` and then dropped its socket. */
async function offlineMachine(name: string): Promise<MachineId> {
    const machineId = await pairMachine(name);
    const d = inMemoryHarness({ machineId, environments: [inMemoryEnvironment(machineId, E1)] }).start({ events: 3, heartbeatMs: 600_000 }) as InMemoryDaemon;
    daemons.push(d);
    const seat = connect(machineId, d);
    await online(machineId);
    seat.drop();
    await online(machineId, false);
    return machineId;
}

async function everything(): Promise<AuditEvent[]> {
    const all: AuditEvent[] = [];
    let cursor: number | null = null;
    for (;;) {
        const page: { events: readonly AuditEvent[]; next: number | null } = await audit().list({ limit: 200, cursor });
        all.push(...page.events);
        if (page.next === null) return all;
        cursor = page.next;
    }
}

const countBy = (events: readonly AuditEvent[]): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const e of events) out[e.kind] = (out[e.kind] ?? 0) + 1;
    return out;
};
const ofKind = (events: readonly AuditEvent[], kind: AuditKind) => events.filter((e) => e.kind === kind);

describe('the audit trail of a scripted scenario', () => {
    it('records each action kind exactly once per occurrence, lists with filters and a cursor, and survives a fresh host', async () => {
        // 1. Configure an API agent: one config version.
        const api = await agent('agent_api', { runtime: 'anthropic-api' });

        // 2. A task whose turn asks for permission: environment chosen, approval requested and resolved, four transitions.
        await createTask('t1', api, 'approve please');
        const started = await routing().run('t1' as TaskId);
        expect(started.status).toBe('active');
        await until(async () => (await task('t1').get()).wait?.kind === 'approval', 't1 to wait for approval');
        const waiting = await task('t1').get();
        const requestId = (waiting.wait as { requestId: string }).requestId;
        const decided = await session(waiting.sessionId!).respond(requestId, { type: 'permission', outcome: 'allow', scope: 'once' });
        expect(decided.kind).toBe('ack');
        await settled('t1');
        const t1 = await task('t1').get();
        expect(t1.status).toBe('completed');
        expect(t1.result?.text).toBe('ran it');
        expect(t1.transitions.map((x) => `${x.from}>${x.to}`)).toEqual(['queued>active', 'active>waiting', 'waiting>active', 'active>completed']);

        // 3. A delegation from an active task: one delegation record, two transitions on the parent.
        await createTask('t2', api, 'parent work');
        await task('t2').start('user:u1', 'sess_parent' as SessionId);
        const childId = await task('t2').delegate({ callId: 'call_1', objective: 'sub work', assignee: api, sessionId: 'sess_parent' as SessionId });
        expect((await task('t2').get()).wait).toEqual({ kind: 'child', childTaskIds: [childId] });

        // 4. A machine paired, its environment offline, a task under `fallback-api`: two environment choices (one a fallback), then a revoke.
        const m1 = await offlineMachine('laptop');
        const cc = await agent('agent_cc', { runtime: 'in-memory', defaultEnvironmentId: E1, offlinePolicy: 'fallback-api' });
        await createTask('t3', cc, 'run on the laptop', { environmentId: E1 });
        await routing().run('t3' as TaskId);
        await settled('t3');
        const t3 = await task('t3').get();
        expect(t3.status).toBe('completed');
        expect(t3.transitions.map((x) => `${x.from}>${x.to}`)).toEqual(['queued>waiting', 'waiting>active', 'active>completed']);
        await machine(m1, elevated).revoke();
        await machine(m1, elevated).revoke(); // idempotent: no second record

        // 5. Registry: enable (twice — once recorded), grant, open a secret, disable.
        await registry().register(
            {
                id: 'github',
                version: '1.0.0',
                kind: 'connector',
                name: 'GitHub MCP',
                description: 'MCP server at api.github.com',
                capabilities: ['tools'],
                config: { type: 'object' },
                permissions: [{ scope: 'secret:*', reason: 'bearer token' }],
                compat: { platform: '*', core: '*' }
            },
            { enabled: false }
        );
        await registry().enable('github');
        await registry().enable('github');
        await registry().grant('github', ['secret:*']);
        await registry().grant('github', ['secret:*']); // nothing new: no record
        await registry().setSecret('token', 'ghp_x');
        expect(await registry().openSecret('token', 'github')).toBe('ghp_x');
        await registry().disable('github');

        // 6. A proposal accepted by the user: one review, one more config version.
        const agentActor = app.as(owner).actor(AgentActor, agentKey(WS, api));
        const [proposal] = await agentActor.propose([{ kind: 'instruction', patch: 'Always cite sources.', reason: 'asked twice', requiresReview: true }], { kind: 'task-end', sessionId: 'sess_parent' as SessionId, taskId: 't2' as TaskId });
        await agentActor.reviewProposal(proposal!.id, 'accept');

        // A worktree needs a daemon that adds one: `workdir.worktree-created` is covered by the Machine tests (#189), `workdir.command-run` too (#618); `project.chat-released` by the Routing projects tests (#623).
        // `plugin.activated` needs a second plugin of a single-slot kind: covered by the Registry catalogue tests (#229).
        // `plugin.revoked` / `plugin.tool-policy` are covered by the Registry tool-policy tests (#631).
        // `environment.put` / `environment.removed` need a daemon that answers `env.request`: covered by the Machine tests (#237).
        // `chat.project-set` / `chat.machine-set` / `project.changed` are covered by the Chat and Workspace tests (#332).
        // `session.interrupted` / `session.resumed` / `task.machine-lost` need a daemon that goes away: covered by the Routing tests (#366).
        // The `machine.update*` / `machine.channel-set` kinds need a daemon that updates: covered by the Machine update tests (#365).
        // `harness.changed` needs a daemon that changes a harness: covered by the Machine harness tests (#370).
        // `pull.merged` / `pull.closed` need a pull request source: covered by the Pulls tests (#742).
        // `plan.changed` / `plan.lease-expired` are covered by the Plan actor tests (#750).
        // The #355 kinds `machine.policy-set` / `machine.renamed` are covered by the Machine policy tests (#480); `machine.restart-requested` / `machine.restarted` (#481) and `machine.login` (#484) by theirs.
        const expected: Record<Exclude<AuditKind, 'workdir.worktree-created' | 'workdir.command-run' | 'project.chat-released' | 'connector.connected' | 'connector.disconnected' | 'connector.needs-reauth' | 'plugin.activated' | 'plugin.revoked' | 'plugin.tool-policy' | 'environment.put' | 'environment.removed' | 'chat.project-set' | 'chat.machine-set' | 'project.changed' | 'session.interrupted' | 'session.resumed' | 'task.machine-lost' | 'machine.update-requested' | 'machine.updated' | 'machine.update-failed' | 'machine.channel-set' | 'machine.update-policy-set' | 'harness.changed' | 'machine.policy-set' | 'machine.renamed' | 'machine.restart-requested' | 'machine.restarted' | 'machine.login' | 'pull.merged' | 'pull.closed' | 'plan.changed' | 'plan.lease-expired'>, number> = {
            'config.versioned': 3, // agent_api v1, agent_cc v1, agent_api v2 (the accepted proposal)
            'environment.chosen': 3, // t1 (api), t3 (E1), t3 fallback
            'task.transition': 9, // t1 ×4, t2 ×2, t3 ×3
            'approval.requested': 1,
            'approval.resolved': 1,
            'delegation.created': 1,
            'machine.paired': 1,
            'machine.revoked': 1,
            'auth.elevated': 1, // the revoke was the elevation's first change (#355)
            'plugin.enabled': 1,
            'plugin.granted': 1,
            'secret.opened': 1,
            'plugin.disabled': 1,
            'proposal.reviewed': 1
        };
        const total = Object.values(expected).reduce((a, b) => a + b, 0);
        await until(async () => (await audit().stats()).recorded >= total, `${total} audit records`);
        const all = await everything();
        expect(countBy(all)).toEqual(expected);
        expect(new Set(all.map((e) => e.key)).size).toBe(all.length);
        expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => all.length - 1 - i));

        // Each occurrence, once, with what it said.
        const t1Edges = ofKind(all, 'task.transition')
            .filter((e) => e.taskId === 't1')
            .reverse();
        expect(t1Edges.map((e) => e.kind === 'task.transition' && `${e.data.from}>${e.data.to}`)).toEqual(['queued>active', 'active>waiting', 'waiting>active', 'active>completed']);
        expect(t1Edges[1]).toMatchObject({ by: 'system:routing', agentId: api, sessionId: t1.sessionId, data: { wait: { kind: 'approval', requestId } } });
        const requested = ofKind(all, 'approval.requested')[0]!;
        expect(requested).toMatchObject({ by: `agent:${api}`, agentId: api, taskId: 't1', sessionId: t1.sessionId, data: { requestId, toolName: 'shell' } });
        expect(ofKind(all, 'approval.resolved')[0]).toMatchObject({ by: 'user:u1', taskId: 't1', data: { requestId, outcome: 'allow', resolvedBy: 'client', scope: 'once' } });
        expect(ofKind(all, 'delegation.created')[0]).toMatchObject({
            by: `agent:${api}`,
            agentId: api,
            taskId: 't2',
            sessionId: 'sess_parent',
            data: { parentTaskId: 't2', childTaskId: childId, assignee: api, owner: api, objective: 'sub work', callId: 'call_1' }
        });
        const choices = ofKind(all, 'environment.chosen').reverse();
        expect(choices.map((e) => e.kind === 'environment.chosen' && [e.taskId, e.data.runtime, e.data.environmentId, e.data.fallback])).toEqual([
            ['t1', 'anthropic-api', undefined, false],
            ['t3', 'in-memory', E1, false],
            ['t3', 'anthropic-api', undefined, true]
        ]);
        expect(choices[2]).toMatchObject({ by: 'system:routing', agentId: cc, data: { policy: 'fallback-api', from: { runtime: 'in-memory', environmentId: E1, machineId: m1 } } });
        expect(choices[2]!.summary).toMatch(/^fallback-api: environment env_1 on machine .* is offline; running on anthropic-api/);
        expect(ofKind(all, 'machine.paired')[0]).toMatchObject({ by: 'user:u1', data: { machineId: m1, name: 'laptop' } });
        expect(ofKind(all, 'machine.revoked')[0]).toMatchObject({ by: 'user:u1', data: { machineId: m1, name: 'laptop' } });
        expect(ofKind(all, 'plugin.granted')[0]).toMatchObject({ data: { pluginId: 'github', scopes: ['secret:*'] } });
        expect(ofKind(all, 'secret.opened')[0]).toMatchObject({ by: 'user:u1', data: { name: 'token', pluginId: 'github' } });
        expect(ofKind(all, 'proposal.reviewed')[0]).toMatchObject({ by: 'user:u1', agentId: api, data: { proposalId: proposal!.id, decision: 'accept', version: 2 } });
        const versions = ofKind(all, 'config.versioned').reverse();
        expect(versions.map((e) => e.kind === 'config.versioned' && [e.agentId, e.data.version, e.by])).toEqual([
            [api, 1, 'user:u1'],
            [cc, 1, 'user:u1'],
            [api, 2, 'user:u1']
        ]);

        // Filters: by kind, by agent, by task (a delegation shows under its child too), by time, and paged by cursor.
        expect((await audit().list({ kinds: ['task.transition'], taskId: 't1', limit: 200 })).events).toHaveLength(4);
        expect((await audit().list({ agentId: cc, limit: 200 })).events.map((e) => e.kind).sort()).toEqual(['config.versioned', 'environment.chosen', 'environment.chosen', 'task.transition', 'task.transition', 'task.transition']);
        expect((await audit().list({ taskId: childId })).events.map((e) => e.kind)).toEqual(['delegation.created']);
        const pairedAt = ofKind(all, 'machine.paired')[0]!.at;
        const before = await audit().list({ until: pairedAt, limit: 200 });
        expect(before.events.every((e) => e.at < pairedAt)).toBe(true);
        expect(before.events.length + (await audit().list({ since: pairedAt, limit: 200 })).events.length).toBe(all.length);
        const p1 = await audit().list({ limit: 5 });
        const p2 = await audit().list({ limit: 5, cursor: p1.next });
        expect(p1.events).toHaveLength(5);
        expect(p2.events).toHaveLength(5);
        expect([...p1.events, ...p2.events].map((e) => e.seq)).toEqual(all.slice(0, 10).map((e) => e.seq));

        // The log survives re-activation: a fresh host over the same storage reads the same history.
        await app.stop();
        app = testActorApp(actors(), { storage });
        await app.start();
        expect(await everything()).toEqual(all);
    });
});
