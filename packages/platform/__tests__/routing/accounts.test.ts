/**
 * Accounts across machines in the router (#414, #417; EXE-02, EXE-06, EXE-12,
 * EXE-13, AST-05, OPS-03): a task that names a machine lands on the
 * environment of the assignee's account THERE — the agent's `execution.account`,
 * or the login of its pinned environment — bound to that machine at `run`,
 * so two daemons that both minted `env_work` are never confused. An account
 * absent on the machine fails the task by name; a machine offline parks it
 * on that machine; a task naming no machine keeps the old resolution. Same
 * in-process host as `workdir.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actorKey, type AccountRef, type AgentId, type ChatId, type EnvironmentDescriptor, type EnvironmentId, type MachineId, type MessageId, type OfflinePolicy, type Principal, type RuntimeId, type SessionId, type TaskContract, type TaskId, type WorkspaceId } from '@agentic/core';
import { inMemoryEnvironment, inMemoryHarness, type InMemoryDaemon, type PlatformSeat } from '@agentic/daemon-protocol/testing';
import { allowAll } from '@sigx/ai-agent';
import { mockAgent } from '@sigx/ai-agent/testing';

import { AgentActor, agentKey } from '../../src/agent/index';
import { capturingAuditPort } from '../../src/audit/index';
import { workspaceKey } from '../../src/auth/index';
import { Chat, ChatPage } from '../../src/chat/index';
import { defineMachineActor, machineKey, parseMachineKey, type MachineSocketPort } from '../../src/machine/index';
import { PairingDirectory } from '../../src/pairing/index';
import { createToolCallPort, defineRoutingActor, routingKey } from '../../src/routing/index';
import { defineSessionActor, type CommandSink, type SessionFactory } from '../../src/session/index';
import { TaskActor, taskKey, type TaskView } from '../../src/task/index';
import { Workspace } from '../../src/workspace/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
/** Both machines mint the same ids for different logins — the collision the machine tells apart. */
const WORK = 'env_work' as EnvironmentId;
const HOME = 'env_home' as EnvironmentId;
const asMachine = (id: MachineId): Principal => ({ kind: 'machine', workspaceId: WS, machineId: id });

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
    /** The `session.open` frames the platform sent this machine: session id → `{ environmentId, cwd }`. */
    opens(key: string): Record<string, { environmentId: string; cwd: string | undefined }> {
        const out: Record<string, { environmentId: string; cwd: string | undefined }> = {};
        for (const t of this.sent.get(key) ?? []) {
            const f = JSON.parse(t) as { t: string; sessionId?: string; environmentId?: string; spec?: { cwd?: string } };
            if (f.t === 'session.open') out[f.sessionId!] = { environmentId: f.environmentId!, cwd: f.spec?.cwd };
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

function localFactory(): SessionFactory {
    const agent = mockAgent({ respond: () => [{ text: 'done' }] });
    return async (runtime, c) => {
        if (runtime !== 'anthropic-api') return null;
        const session = await agent.session({ policy: allowAll, signal: c.signal });
        return { session, agentId: agent.id, capabilities: agent.capabilities };
    };
}

let app: TestActorApp;
let sockets: FakeSockets;
let audit: ReturnType<typeof capturingAuditPort>;
let Session: ReturnType<typeof defineSessionActor>;
let Machine: ReturnType<typeof defineMachineActor>;
let Routing: ReturnType<typeof defineRoutingActor>;
const daemons: InMemoryDaemon[] = [];
beforeEach(async () => {
    sockets = new FakeSockets();
    audit = capturingAuditPort();
    const sink: CommandSink = { send: (t, cmd) => app.as(owner).actor(Machine, machineKey(t.workspaceId, t.machineId)).sendCommand(t.sessionId, cmd) };
    Session = defineSessionActor({ factory: localFactory(), commands: sink });
    Routing = defineRoutingActor({ sessions: () => Session, machines: () => Machine, audit });
    Machine = defineMachineActor({ socket: sockets, sessions: () => Session, routing: () => Routing, tools: createToolCallPort({ routing: () => Routing, sessions: () => Session }) });
    app = testActorApp([Routing, Session, Machine, TaskActor, AgentActor, Workspace, PairingDirectory, Chat, ChatPage]);
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
const chat = (id: string) => app.as(owner).actor(Chat, actorKey(WS, 'chat', id as ChatId));

async function agent(id: string, execution: { runtime: RuntimeId; account?: AccountRef; defaultEnvironmentId?: EnvironmentId; defaultWorkdir?: string; offlinePolicy?: OfflinePolicy }): Promise<AgentId> {
    const agentId = id as AgentId;
    await app.as(owner).actor(AgentActor, agentKey(WS, agentId)).update({ name: id, instructions: 'Be brief.', tools: [], execution: { offlinePolicy: 'fail', ...execution } }, 'create');
    return agentId;
}

async function createTask(id: string, assignee: AgentId, extra: Partial<TaskContract> = {}): Promise<TaskView> {
    return task(id).create({ objective: 'do the thing', origin: { kind: 'external', clientId: 'c1' }, assignee, context: [], constraints: {}, ...extra }, { owner: assignee });
}

type Login = { readonly id: EnvironmentId; readonly identity?: string; readonly label?: string; readonly authStatus?: EnvironmentDescriptor['account']['authStatus']; readonly roots?: readonly string[] };

/** A paired machine whose daemon reports the given logins; `connect` dials it. Every environment runs `in-memory`. */
async function pairMachine(name: string, logins: readonly Login[]): Promise<{ machineId: MachineId; d: InMemoryDaemon; connect(): PlatformSeat }> {
    const { machineId, pairingCode } = await workspace().registerMachinePending({ name });
    await machine(machineId).pair(pairingCode, { name });
    const environments = logins.map((l) => ({
        ...inMemoryEnvironment(machineId, l.id),
        name: l.id,
        account: { label: l.label ?? l.id, authStatus: l.authStatus ?? 'ok', ...(l.identity !== undefined ? { identity: l.identity } : {}) },
        cwdRoots: [...(l.roots ?? [`/${name}/${l.id}`])]
    }));
    const d = inMemoryHarness({ machineId, environments }).start({ events: 2, heartbeatMs: 600_000 }) as InMemoryDaemon;
    daemons.push(d);
    const connect = (): PlatformSeat => {
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
    };
    return { machineId, d, connect };
}

async function online(name: string, logins: readonly Login[]): Promise<MachineId> {
    const m = await pairMachine(name, logins);
    m.connect();
    await until(async () => (await machine(m.machineId).get()).online, `${name} to come online`);
    return m.machineId;
}

/** A machine that was online once and dropped: its environments stay on the record, `online` is false. */
async function offline(name: string, logins: readonly Login[]): Promise<{ machineId: MachineId; connect(): PlatformSeat }> {
    const m = await pairMachine(name, logins);
    const seat = m.connect();
    await until(async () => (await machine(m.machineId).get()).online, `${name} online`);
    seat.drop();
    await until(async () => !(await machine(m.machineId).get()).online, `${name} offline`);
    return m;
}

const settled = (id: string) => until(async () => ['completed', 'failed', 'cancelled'].includes((await task(id).get()).status), `task ${id} to settle`);
const chosenFor = (taskId: string) => audit.events.find((e) => e.kind === 'environment.chosen' && e.taskId === taskId && !e.key.endsWith(':fallback'));

/** Where `taskId`'s session opened: the machine that got `session.open`, its environment and folder, and the Session record's. */
async function placedAt(taskId: string): Promise<{ machineId: MachineId | undefined; environmentId: string | undefined; cwd: string | undefined; record: { machineId?: MachineId; environmentId?: EnvironmentId } }> {
    const t = await task(taskId).get();
    const sessionId = t.sessionId as SessionId;
    let machineId: MachineId | undefined;
    let open: { environmentId: string; cwd: string | undefined } | undefined;
    for (const m of await workspace().listMachines()) {
        const found = sockets.opens(machineKey(WS, m.id))[sessionId];
        if (found) {
            machineId = m.id;
            open = found;
        }
    }
    const spec = (await session(sessionId).get()).spec;
    return { machineId, environmentId: open?.environmentId, cwd: open?.cwd, record: { ...(spec?.machineId ? { machineId: spec.machineId } : {}), ...(spec?.environmentId ? { environmentId: spec.environmentId } : {}) } };
}

// Two logins: `me@work` and `me@home`; both machines mint `env_work` / `env_home` for them.
const LOGINS: readonly Login[] = [
    { id: WORK, identity: 'me@work' },
    { id: HOME, identity: 'me@home' }
];

describe('the account on the task’s machine (#414)', () => {
    it('an account agent runs on the environment of its account on the machine the task names — the audit names the machine and the account', async () => {
        const mac = await online('mac', LOGINS);
        const pc = await online('pc', LOGINS);
        const a = await agent('agent_work', { runtime: 'in-memory', account: { identity: 'ME@Work' } });
        await createTask('t_pc', a, { machineId: pc });
        await createTask('t_mac', a, { machineId: mac });
        await routing().run('t_pc' as TaskId);
        await routing().run('t_mac' as TaskId);
        await Promise.all([settled('t_pc'), settled('t_mac')]);
        expect((await task('t_pc').get()).status).toBe('completed');
        expect(await placedAt('t_pc')).toEqual({ machineId: pc, environmentId: WORK, cwd: '/pc/env_work', record: { machineId: pc, environmentId: WORK } });
        expect(await placedAt('t_mac')).toEqual({ machineId: mac, environmentId: WORK, cwd: '/mac/env_work', record: { machineId: mac, environmentId: WORK } });
        expect(chosenFor('t_pc')).toMatchObject({ data: { environmentId: WORK, machineId: pc, account: 'in-memory|id:me@work', cwd: '/pc/env_work' } });
        expect(chosenFor('t_pc')!.summary).toMatch(/environment env_work \(the agent's account ME@Work on machine \S+ \(pc\) \(the task's own\)\); folder \/pc\/env_work \(the environment's first root\)/);
        // The route was bound to the machine at `run`, never by index order.
        expect((await routing().get()).routes).toEqual([]);
    });

    it('the machine offline: the task waits environment-offline on THAT machine under `queue`, the other machine’s hello does nothing, its own places it', async () => {
        await online('mac', LOGINS);
        const pc = await offline('pc', LOGINS);
        const a = await agent('agent_work', { runtime: 'in-memory', account: { identity: 'me@work' }, offlinePolicy: 'queue' });
        await createTask('t1', a, { machineId: pc.machineId });
        const t = await routing().run('t1' as TaskId);
        expect(t.status).toBe('waiting');
        expect(t.wait).toMatchObject({ kind: 'environment-offline', environmentId: WORK, policy: 'queue' });
        const [route] = (await routing().get()).routes;
        expect(route).toMatchObject({ taskId: 't1', status: 'waiting-offline', environmentId: WORK, machineId: pc.machineId, requestedMachineId: pc.machineId, account: 'in-memory|id:me@work' });
        // The mac, online and reporting the same account and id, is not where this task goes (EXE-12).
        await new Promise((r) => setTimeout(r, 50));
        expect((await task('t1').get()).status).toBe('waiting');
        pc.connect();
        await settled('t1');
        expect((await task('t1').get()).status).toBe('completed');
        expect((await placedAt('t1')).machineId).toBe(pc.machineId);
    });

    it('an account the machine has no login for fails the task account-not-on-machine (recoverable) and tells the chat; `fallback-api` never applies', async () => {
        const pc = await online('pc', [{ id: WORK, identity: 'me@work' }]);
        const a = await agent('agent_home', { runtime: 'in-memory', account: { identity: 'me@home' }, offlinePolicy: 'fallback-api' });
        const c = chat('c1');
        await c.addAgent(a);
        const { messageId } = await c.post('hello', [a]);
        await task('t1').create({ objective: 'hello', origin: { kind: 'user', chatId: 'c1' as ChatId, messageId: messageId as MessageId }, assignee: a, context: [], constraints: {}, machineId: pc }, { owner: a });
        const t = await routing().run('t1' as TaskId);
        expect(t.status).toBe('failed');
        expect(t.error).toMatchObject({ code: 'account-not-on-machine', recoverable: true });
        expect(t.error!.message).toMatch(/account me@home \(the agent's account\) is not signed in on machine \S+ \(pc\) \(the task's own\) for runtime in-memory; sign it in there/);
        expect(sockets.opens(machineKey(WS, pc))).toEqual({});
        expect((await routing().get()).routes).toEqual([]);
        const { entries } = await c.history();
        expect(entries.map((e) => e.entry).filter((e) => e.t === 'status' && e.kind === 'task-failed')).toHaveLength(1);
        // No `environment.chosen`: nothing was chosen.
        expect(chosenFor('t1')).toBeUndefined();
    });

    it('several environments of the account on the machine: the signed-in one first, then by name, the rest named in the audit', async () => {
        const pc = await online('pc', [
            { id: 'env_b' as EnvironmentId, identity: 'me@work' },
            { id: 'env_a' as EnvironmentId, identity: 'me@work', authStatus: 'expired' },
            { id: 'env_c' as EnvironmentId, identity: 'me@work' }
        ]);
        const a = await agent('agent_work', { runtime: 'in-memory', account: { identity: 'me@work' } });
        await createTask('t1', a, { machineId: pc });
        await routing().run('t1' as TaskId);
        await settled('t1');
        expect((await placedAt('t1')).environmentId).toBe('env_b');
        expect(chosenFor('t1')!.summary).toMatch(/the account is also on env_c, env_a there — the first by sign-in and name is taken/);
    });

    it('a legacy agent pinned to an environment: the pin as the named machine reports it, else the pin’s login there; without a machine the pin holds', async () => {
        // The mac is first in the index and reports `env_work` for me@work; the pc reports `env_wrk` for me@work and `env_work` for nobody.
        await online('mac', LOGINS);
        const pc = await online('pc', [{ id: 'env_wrk' as EnvironmentId, identity: 'me@work' }]);
        const a = await agent('agent_pinned', { runtime: 'in-memory', defaultEnvironmentId: WORK, defaultWorkdir: '/mac/env_work/app' });
        await createTask('t1', a, { machineId: pc });
        await routing().run('t1' as TaskId);
        await settled('t1');
        // The pc does not report `env_work`: the account of `env_work` as the mac reports it is me@work — on the pc that is `env_wrk`; the pin's folder does not follow.
        expect(await placedAt('t1')).toMatchObject({ machineId: pc, environmentId: 'env_wrk', cwd: '/pc/env_wrk' });
        expect(chosenFor('t1')).toMatchObject({ data: { environmentId: 'env_wrk', machineId: pc, account: 'in-memory|id:me@work' } });
        expect(chosenFor('t1')!.summary).toMatch(/the account of the agent's environment env_work me@work on machine/);
        // A machine that reports the pinned id itself: that environment, as it stands — the pin names an environment, the task the machine.
        const other = await online('other', [{ id: WORK, identity: 'someone@else', roots: ['/other/env_work'] }]);
        await createTask('t2', a, { machineId: other });
        await routing().run('t2' as TaskId);
        await settled('t2');
        expect(await placedAt('t2')).toMatchObject({ machineId: other, environmentId: WORK, cwd: '/other/env_work' });
        expect(chosenFor('t2')).toMatchObject({ data: { environmentId: WORK, machineId: other } });
        expect(chosenFor('t2')!.data).not.toHaveProperty('account');
        expect(chosenFor('t2')!.summary).toMatch(/environment env_work \(the agent's default\); folder \/other\/env_work \(the environment's first root\).*; on machine \S+ \(other\) \(the task's own\), which reports it/);
        // Without a machine, the pin holds as before — on the first machine reporting it, with the pin's folder.
        await createTask('t3', a);
        await routing().run('t3' as TaskId);
        await settled('t3');
        expect(await placedAt('t3')).toMatchObject({ environmentId: WORK, cwd: '/mac/env_work/app' });
        expect(chosenFor('t3')!.summary).toMatch(/(the agent's default)/);
    });

    it('a task’s own environment wins when the named machine reports it; one it does not report is left aside with its folder, and the audit says so', async () => {
        const mac = await online('mac', LOGINS);
        const pc = await online('pc', [{ id: WORK, identity: 'me@work' }, { id: HOME, identity: 'me@home', roots: ['/pc/home', '/pc/scratch'] }]);
        const a = await agent('agent_work', { runtime: 'in-memory', account: { identity: 'me@work' } });
        // `env_home` on the pc, explicitly, with a folder there — the machine tells the colliding ids apart.
        await createTask('t1', a, { machineId: pc, environmentId: HOME, workdir: '/pc/scratch/x' });
        await routing().run('t1' as TaskId);
        await settled('t1');
        expect(await placedAt('t1')).toMatchObject({ machineId: pc, environmentId: HOME, cwd: '/pc/scratch/x' });
        expect(chosenFor('t1')!.summary).toMatch(/environment env_home \(the task's own\); folder \/pc\/scratch\/x \(the task's own\)/);
        // An environment the pc does not report (a member's folder picked on the mac): the account's environment on the pc instead.
        await createTask('t2', a, { machineId: pc, environmentId: 'env_mac_only' as EnvironmentId, workdir: '/mac/wherever' });
        await routing().run('t2' as TaskId);
        await settled('t2');
        expect(await placedAt('t2')).toMatchObject({ machineId: pc, environmentId: WORK, cwd: '/pc/env_work' });
        expect(chosenFor('t2')).toMatchObject({ data: { environmentId: WORK, machineId: pc, ignoredEnvironment: 'env_mac_only', ignoredWorkdir: '/mac/wherever' } });
        expect(chosenFor('t2')!.summary).toMatch(/environment env_mac_only and folder \/mac\/wherever left aside: machine \S+ does not report it/);
        expect((await placedAt('t2')).machineId).not.toBe(mac);
    });

    it('an account agent with no machine named fails no-machine; a pinned agent keeps the old chain', async () => {
        await online('mac', LOGINS);
        const a = await agent('agent_work', { runtime: 'in-memory', account: { identity: 'me@work' } });
        await createTask('t1', a);
        const t = await routing().run('t1' as TaskId);
        expect(t.status).toBe('failed');
        expect(t.error).toMatchObject({ code: 'no-machine', recoverable: false });
        expect(t.error!.message).toMatch(/runs as account me@work on whichever machine the chat names.*pick a machine for the chat/);
        expect(chosenFor('t1')).toBeUndefined();
        const b = await agent('agent_pinned', { runtime: 'in-memory', account: { identity: 'me@work' }, defaultEnvironmentId: WORK });
        await createTask('t2', b);
        await routing().run('t2' as TaskId);
        await settled('t2');
        expect(await placedAt('t2')).toMatchObject({ environmentId: WORK });
    });

    it('a delegated child inherits the parent’s machine and resolves ITS OWN account there; the parent’s folder is not inherited across accounts', async () => {
        await online('mac', LOGINS);
        const pc = await offline('pc', LOGINS);
        const a = await agent('agent_work', { runtime: 'in-memory', account: { identity: 'me@work' }, offlinePolicy: 'queue' });
        const b = await agent('agent_home', { runtime: 'in-memory', account: { identity: 'me@home' }, offlinePolicy: 'queue' });
        await createTask('p1', a, { machineId: pc.machineId, environmentId: WORK, workdir: '/pc/env_work/app' });
        expect((await routing().run('p1' as TaskId)).status).toBe('waiting');
        const origin = { kind: 'agent', agentId: a, taskId: 'p1' as TaskId, sessionId: 'session_p1' as SessionId, callId: 'call_1' } as const;
        // The child names nothing: the parent's machine, the child's own account.
        await task('c1').create({ objective: 'child', origin, assignee: b, context: [], constraints: {} }, { owner: a, depth: 1, parentId: 'p1' as TaskId });
        // A child of the same agent: the parent's machine, environment and folder.
        await task('c2').create({ objective: 'child same', origin: { ...origin, callId: 'call_2' }, assignee: a, context: [], constraints: {} }, { owner: a, depth: 1, parentId: 'p1' as TaskId });
        await routing().run('c1' as TaskId);
        await routing().run('c2' as TaskId);
        const routes = Object.fromEntries((await routing().get()).routes.map((r) => [r.taskId, { env: r.environmentId, machine: r.machineId, cwd: r.cwd, account: r.account }]));
        expect(routes).toEqual({
            p1: { env: WORK, machine: pc.machineId, cwd: '/pc/env_work/app', account: undefined },
            c1: { env: HOME, machine: pc.machineId, cwd: '/pc/env_home', account: 'in-memory|id:me@home' },
            c2: { env: WORK, machine: pc.machineId, cwd: '/pc/env_work/app', account: 'in-memory|id:me@work' }
        });
        expect(chosenFor('c1')!.summary).toMatch(/the agent's account me@home on machine \S+ \(pc\) \(the delegating task's\)/);
        pc.connect();
        await Promise.all(['p1', 'c1', 'c2'].map(settled));
        for (const id of ['p1', 'c1', 'c2']) expect((await placedAt(id)).machineId).toBe(pc.machineId);
    });

    it('a machine that never connected, an unpaired one and a revoked one are named, not guessed around', async () => {
        const { machineId: fresh } = await pairMachine('fresh', LOGINS);
        const { machineId: pending } = await workspace().registerMachinePending({ name: 'pending' });
        const a = await agent('agent_work', { runtime: 'in-memory', account: { identity: 'me@work' } });
        await createTask('t1', a, { machineId: fresh });
        const t1 = await routing().run('t1' as TaskId);
        expect(t1.error).toMatchObject({ code: 'account-not-on-machine', recoverable: true });
        expect(t1.error!.message).toMatch(/has not reported its environments yet/);
        await createTask('t2', a, { machineId: pending });
        expect((await routing().run('t2' as TaskId)).error).toMatchObject({ code: 'machine-unknown', recoverable: false });
        await createTask('t3', a, { machineId: 'machine_nope' as MachineId });
        expect((await routing().run('t3' as TaskId)).error).toMatchObject({ code: 'machine-unknown' });
        const gone = await online('gone', LOGINS);
        await machine(gone).revoke();
        await createTask('t4', a, { machineId: gone });
        expect((await routing().run('t4' as TaskId)).error).toMatchObject({ code: 'machine-unknown' });
        expect((await routing().get()).routes).toEqual([]);
    });

    it('an agent with no account and no pin on a named machine takes the workspace’s default environment there, else fails no-account', async () => {
        const pc = await online('pc', LOGINS);
        const a = await agent('agent_plain', { runtime: 'in-memory' });
        await createTask('t1', a, { machineId: pc });
        expect((await routing().run('t1' as TaskId)).error).toMatchObject({ code: 'no-account', recoverable: false });
        await workspace().updateSettings({ defaults: { environmentId: HOME } });
        await createTask('t2', a, { machineId: pc });
        await routing().run('t2' as TaskId);
        await settled('t2');
        expect(await placedAt('t2')).toMatchObject({ machineId: pc, environmentId: HOME });
        expect(chosenFor('t2')!.summary).toMatch(/the workspace's default on machine/);
    });
});
