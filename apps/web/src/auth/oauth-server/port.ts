/**
 * The real `PlatformPort` (architecture §9): the orchestration tools bound
 * to the actors, per external principal. Every capability call is a FRESH
 * `actor()` call under the client's principal, so each actor's own
 * `authorize` chain (`sameWorkspace` + its scope policy) decides — the port
 * never widens what the token allows. Two things run as the workspace's
 * user instead, because they are the platform's own machinery rather than
 * a capability the client holds: reading the Workspace index (the root
 * actor admits its owner only) and driving the router (`Routing.run`, the
 * same principal the schedule trigger uses).
 */
import { createId, type AgentId, type EnvironmentDescriptor, type MachineId, type Principal, type TaskContract, type TaskId, type WorkspaceId } from '@agentic/core';
import type { ExternalPrincipal, PlatformPort, TaskSummary, TaskTreeNode } from '@agentic/mcp';
import {
    AgentActor,
    Chat,
    Memory,
    TaskActor,
    Workspace,
    agentChatKey,
    agentKey,
    asPrincipal,
    machineKey,
    memoryActorKey,
    routingKey,
    taskKey,
    userPrincipal,
    workspaceKey,
    type MachineActor,
    type MachineView,
    type RoutingActor,
    type ScheduleActor,
    type SessionActor,
    type TaskTree,
    type TaskView
} from '@agentic/platform';
import { actor, type ActorClientWith, type AnyActorDefinition } from '@sigx/actors';
import { ServerFnError } from '@sigx/server';

export interface ActorPortOptions {
    /** The registry this deployment built (`platformActors()`); Session, Machine, Routing and Schedule are looked up by type. */
    readonly actors: readonly AnyActorDefinition[];
    /** The principal the index reads and the router run as. Default: the workspace's user (v1: `workspaceId === userId`). */
    readonly driver?: (workspaceId: WorkspaceId) => Principal;
}

const byType = <D extends AnyActorDefinition>(actors: readonly AnyActorDefinition[], type: string): D => {
    const def = actors.find((d) => (d as { type: string }).type === type);
    if (!def) throw new Error(`[oauth-server/port] no \`${type}\` actor in the registry`);
    return def as D;
};

const summary = (t: TaskView): TaskSummary => ({
    taskId: t.id,
    status: t.status,
    assignee: t.assignee,
    owner: t.owner,
    objective: t.objective,
    ...(t.environmentId !== undefined ? { environmentId: t.environmentId } : {}),
    ...(t.sessionId !== undefined ? { sessionId: t.sessionId } : {}),
    ...(t.wait !== undefined ? { wait: t.wait } : {}),
    ...(t.result !== undefined ? { result: t.result } : {}),
    ...(t.error !== undefined ? { error: { code: t.error.code, message: t.error.message } } : {}),
    ...(t.parentId !== undefined ? { parentId: t.parentId } : {}),
    ...(t.transitions[0] !== undefined ? { createdAt: t.transitions[0].at } : {}),
    children: t.children
});

const tree = (t: TaskTree): TaskTreeNode => ({ taskId: t.id, status: t.status, assignee: t.assignee, objective: t.objective, depth: t.depth, ...(t.wait !== undefined ? { wait: t.wait } : {}), children: t.children.map(tree) });

/** Build the port for one external principal. */
export function createActorPlatformPort(principal: ExternalPrincipal, options: ActorPortOptions): PlatformPort {
    const { workspaceId, clientId } = principal;
    const Session = byType<SessionActor>(options.actors, 'session');
    const Machine = byType<MachineActor>(options.actors, 'machine');
    const Routing = byType<RoutingActor>(options.actors, 'routing');
    const Schedule = byType<ScheduleActor>(options.actors, 'Schedule');
    const driver = (options.driver ?? ((ws: WorkspaceId): Principal => userPrincipal(ws, ws)))(workspaceId);
    const external = asPrincipal(principal);
    const as = <D extends AnyActorDefinition>(def: D, key: string, who: Principal = principal): ActorClientWith<D> => actor(def, key).with({ context: who === principal ? external : asPrincipal(who) }) as ActorClientWith<D>;

    const workspace = () => as(Workspace, workspaceKey(workspaceId), driver);
    const machine = (id: MachineId, who: Principal = principal) => as(Machine, machineKey(workspaceId, id), who);
    const task = (id: TaskId) => as(TaskActor, taskKey(workspaceId, id));
    const session = (id: string) => as(Session, `${workspaceId}:session:${id}`);
    const by = `external:${clientId}`;

    async function machines(who: Principal = principal): Promise<MachineView[]> {
        const listed = await workspace().listMachines();
        const views: MachineView[] = [];
        for (const entry of listed) {
            if (entry.status !== 'paired') continue;
            views.push(await machine(entry.id, who).get());
        }
        return views;
    }

    async function createTask(contract: TaskContract): Promise<TaskView> {
        const id = createId('task') as TaskId;
        await task(id).create(contract, { owner: contract.assignee });
        // The router runs as the workspace driver (as the schedule trigger does); the task carries the external origin.
        return as(Routing, routingKey(workspaceId), driver).run(id);
    }

    return {
        machines: {
            list: async () =>
                (await machines()).map((m) => ({
                    machineId: m.machineId,
                    name: m.name,
                    online: m.online,
                    ...(m.os !== undefined ? { os: m.os } : {}),
                    ...(m.lastSeen !== undefined ? { lastSeen: m.lastSeen } : {}),
                    ...(m.daemonVersion !== undefined ? { daemonVersion: m.daemonVersion } : {}),
                    environments: m.environments
                }))
        },
        environments: {
            list: async (machineId) => {
                if (machineId !== undefined) return (await machine(machineId).get()).environments;
                const out: EnvironmentDescriptor[] = [];
                for (const m of await machines()) out.push(...m.environments);
                return out;
            }
        },
        agents: {
            list: async () => {
                const { agents } = await workspace().get();
                const out = [];
                for (const id of agents) {
                    const view = await as(AgentActor, agentKey(workspaceId, id)).get();
                    out.push({
                        agentId: view.id,
                        name: view.config.name,
                        runtime: view.config.execution.runtime,
                        ...(view.config.execution.defaultEnvironmentId !== undefined ? { defaultEnvironmentId: view.config.execution.defaultEnvironmentId } : {})
                    });
                }
                return out;
            },
            get: (agentId) => as(AgentActor, agentKey(workspaceId, agentId)).get()
        },
        sessions: {
            async open(input) {
                // Explicit machine selection (EXE-12): the named machine must report the named environment, checked as platform machinery.
                const m = await machine(input.machineId, driver).get();
                const env = m.environments.find((e) => e.id === input.environmentId);
                if (!env) throw new ServerFnError(404, `environment ${input.environmentId} is not reported by machine ${input.machineId}`);
                if (input.cwd !== undefined && env.cwdRoots.length > 0 && !env.cwdRoots.some((root) => input.cwd!.startsWith(root))) {
                    throw new ServerFnError(400, `cwd ${input.cwd} is outside the environment's roots (${env.cwdRoots.join(', ')})`);
                }
                const objective = input.objective ?? `Interactive session for ${input.agentId} on ${m.name} (${env.name})${input.cwd ? ` in ${input.cwd}` : ''}`;
                const view = await createTask({
                    objective,
                    origin: { kind: 'external', clientId },
                    assignee: input.agentId,
                    context: input.cwd !== undefined ? [{ type: 'text', text: `Working directory: ${input.cwd}` }] : [],
                    constraints: {},
                    environmentId: input.environmentId
                });
                return summary(view);
            },
            async prompt(sessionId, text) {
                const turnId = `turn_${crypto.randomUUID()}`;
                const r = await session(sessionId).prompt(text, turnId);
                return { turnId, commandId: r.commandId, kind: r.kind, ...('code' in r ? { code: r.code, message: r.message } : {}) };
            },
            async respond(sessionId, requestId, decision) {
                const r = await session(sessionId).respond(requestId, decision.type === 'permission' ? { type: 'permission', outcome: decision.outcome, scope: decision.scope ?? 'once', ...(decision.message !== undefined ? { message: decision.message } : {}) } : { type: 'input', answers: decision.answers });
                return { commandId: r.commandId, kind: r.kind, ...('code' in r ? { code: r.code, message: r.message } : {}) };
            },
            async cancel(sessionId) {
                const r = await session(sessionId).cancel();
                return { commandId: r.commandId, kind: r.kind, ...('code' in r ? { code: r.code, message: r.message } : {}) };
            },
            async tail(sessionId, from, limit) {
                const client = session(sessionId);
                const [info, events] = await Promise.all([client.get(), client.events(from)]);
                const page = events.slice(0, limit);
                const last = page.at(-1);
                return {
                    sessionId,
                    status: info.status,
                    events: page,
                    next: last ? { epoch: last.epoch, seq: last.seq } : (from ?? { epoch: 0, seq: 0 }),
                    truncated: events.length > page.length
                };
            }
        },
        tasks: {
            create: async (input) =>
                summary(
                    await createTask({
                        objective: input.objective,
                        origin: { kind: 'external', clientId },
                        assignee: input.agentId,
                        context: input.context ?? [],
                        constraints: input.constraints ?? {},
                        ...(input.environmentId !== undefined ? { environmentId: input.environmentId } : {})
                    })
                ),
            get: async (taskId) => summary(await task(taskId).get()),
            tree: async (taskId) => tree(await task(taskId).tree()),
            cancel: async (taskId) => {
                const r = await task(taskId).cancel(by);
                return { taskId: r.id, stopped: r.stopped, notStopped: r.notStopped };
            }
        },
        chats: {
            post: async (input) => {
                const r = await as(Chat, agentChatKey(workspaceId, input.chatId)).post(input.text, input.mentions ?? []);
                return { messageId: r.messageId };
            },
            history: (chatId, cursor, limit) => as(Chat, agentChatKey(workspaceId, chatId)).history(cursor, limit)
        },
        memory: {
            search: (scope, query) => as(Memory, memoryActorKey(workspaceId, scope)).query(query),
            remember: (scope, entry) => as(Memory, memoryActorKey(workspaceId, scope)).put(entry)
        },
        schedules: {
            create: async (input) => {
                const { scheduleId } = await workspace().createSchedule();
                const view = await as(Schedule, `${workspaceId}:schedule:${scheduleId}`).create({
                    kind: input.kind,
                    title: input.title,
                    recurrence: input.recurrence,
                    ...(input.agentId !== undefined ? { agentId: input.agentId as AgentId } : {}),
                    ...(input.environmentId !== undefined ? { environmentId: input.environmentId } : {}),
                    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
                    ...(input.offlinePolicy !== undefined ? { offlinePolicy: input.offlinePolicy } : {})
                });
                return { scheduleId: view.id, title: view.title, kind: view.kind, enabled: view.enabled, next: view.next };
            }
        }
    };
}
