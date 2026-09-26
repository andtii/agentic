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
 *
 * The plan tools (#816) run as the workspace's user too: an external client
 * acts in its user's name on a plan (the `projects` scope gates the family),
 * and the Plan actor admits a person or an agent, never a client. A claim is
 * the one call made as the agent it names — a member of the project — since
 * only an agent claims for itself.
 *
 * The request tools (#930) run as the workspace's user as well, behind the
 * same `projects` scope: a person lists, sends and resolves. Triage is the
 * manager's alone in the Requests actor, so a triage is made as the target
 * project's manager (`pm.agentId`, else its coordinator) — the way a claim is
 * made as its agent — and that project's policy decides what goes to a person.
 */
import { createId, pathWithin, projectFolderPlaces, type AgentId, type EnvironmentDescriptor, type MachineId, type Plan, type Principal, type ProjectId, type ProjectRecord, type SessionId, type TaskContract, type TaskId, type WorkspaceId, type WorkspaceSource } from '@agentic/core';
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
    definePlanActor,
    defineRequestsActor,
    actorResolution,
    projectManagerOf,
    requestsKey,
    type RequestsActorClient,
    mintAgentPrincipal,
    planAdd,
    planHandoffTarget,
    planKey,
    planPatch,
    resolvePlanMember,
    type PlanActorClient,
    type PlanPeople,
    machineKey,
    machineWorkspaceSource,
    memoryActorKey,
    routingKey,
    taskKey,
    usageLimitsOf,
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
import { GIT_FEATURE_ID } from '@agentic/plugins-git';
import { actor, type ActorClientWith, type AnyActorDefinition } from '@sigx/actors';
import { ServerFnError, isServerFnError } from '@sigx/server';

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

/** The Plan actor as a client handle (#816): only its `type` addresses the object; the host runs the registry's own. */
const PlanStore = definePlanActor();

/** The Requests actor as a client handle (#930), like the Plan's. */
const RequestsStore = defineRequestsActor();

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

    /**
     * The ref a session's branch is compared with (#566): the git feature's `base` in the project of the session's
     * task, when it has one. Read as the workspace driver — the task and the project catalogue are the platform's own
     * machinery here, not something the client asked to read (it may hold `sessions` alone). Absent: the daemon picks.
     */
    async function baseOf(taskId: TaskId | undefined): Promise<string | undefined> {
        if (taskId === undefined) return undefined;
        const { projectId } = await as(TaskActor, taskKey(workspaceId, taskId), driver).get();
        if (projectId === undefined) return undefined;
        const project = (await workspace().projects()).find((p) => p.id === projectId);
        const base = project?.features[GIT_FEATURE_ID]?.['base'];
        return typeof base === 'string' && base.trim() !== '' ? base.trim() : undefined;
    }

    /**
     * A session's folder as a `WorkspaceSource` (#566) — the one the Changes and Files views read. The Session is read
     * under the CLIENT's principal, so its `sessions` policy decides whether this client may see the session at all; the
     * record names the machine, environment and folder (`spec.cwd`). The Machine is then asked as the workspace driver,
     * like `usage.limits`: the tools are gated by `sessions`, and a client holding that alone must not also need
     * `machines` — nor can it reach past the session, because every request is rooted at `spec.cwd` on `spec.environmentId`
     * and the daemon confines paths to that root. A session with no folder on a machine (an API runtime) has no files.
     */
    async function sessionFiles(sessionId: SessionId): Promise<WorkspaceSource> {
        const { spec } = await session(sessionId).get();
        if (!spec?.machineId || !spec.environmentId || !spec.cwd) {
            throw new ServerFnError(400, `session ${sessionId} has no folder on a machine${spec ? ` (runtime ${spec.runtime})` : ''}: only sessions that run in a folder on a paired machine have files`);
        }
        const base = await baseOf(spec.taskId);
        return machineWorkspaceSource(machine(spec.machineId, driver), spec.environmentId, spec.cwd, base !== undefined ? { base } : {});
    }

    /** A project's Plan actor as the workspace's user (#816), and its people for handles. */
    async function planOf(projectId: ProjectId): Promise<{ readonly client: PlanActorClient; readonly project: ProjectRecord; readonly people: PlanPeople }> {
        const project = (await workspace().projects()).find((p) => p.id === projectId);
        if (!project) throw new ServerFnError(404, `no project ${projectId} in this workspace`);
        const names = new Map<AgentId, string>();
        await Promise.all(
            project.members.agentIds.map(async (id) => {
                const name = await as(AgentActor, agentKey(workspaceId, id), driver)
                    .get()
                    .then((a) => a.config.name, () => undefined);
                if (name) names.set(id, name);
            })
        );
        const client = as(PlanStore, planKey(workspaceId, projectId), driver) as unknown as PlanActorClient;
        return { client, project, people: { project, names, users: [driver.kind === 'user' ? driver.userId : workspaceId] } };
    }

    /** A project's Requests actor as `who` (default: the workspace's user). */
    const requestsOf = (projectId: ProjectId, who: Principal = driver) => as(RequestsStore, requestsKey(workspaceId, projectId), who) as unknown as RequestsActorClient;

    const inPlan = (plans: readonly Plan[], planId: string | undefined): readonly Plan[] => (planId === undefined ? plans : plans.filter((p) => p.id === planId));

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
            },
            doctor: (machineId, environmentId) => machine(machineId).doctor(environmentId)
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
                // The folder must lie within the roots by the machine's path rules (decision 3, #190) — never a sibling that
                // merely shares a root's prefix — and the router runs the session in it (`TaskContract.workdir` → `OpenSpec.cwd`).
                if (input.cwd !== undefined && !pathWithin(input.cwd, env.cwdRoots, m.os ?? 'windows')) {
                    throw new ServerFnError(400, `cwd ${input.cwd} is outside the environment's roots (${env.cwdRoots.join(', ') || 'none'})`);
                }
                const objective = input.objective ?? `Interactive session for ${input.agentId} on ${m.name} (${env.name})${input.cwd ? ` in ${input.cwd}` : ''}`;
                const view = await createTask({
                    objective,
                    origin: { kind: 'external', clientId },
                    assignee: input.agentId,
                    context: [],
                    constraints: {},
                    environmentId: input.environmentId,
                    ...(input.cwd !== undefined ? { workdir: input.cwd } : {})
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
            },
            tree: async (sessionId, path) => (await sessionFiles(sessionId)).tree(path),
            read: async (sessionId, path, rev) => (await sessionFiles(sessionId)).read(path, rev),
            changes: async (sessionId, scope) => (await sessionFiles(sessionId)).changes(scope)
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
                        ...(input.environmentId !== undefined ? { environmentId: input.environmentId } : {}),
                        ...(input.machineId !== undefined ? { machineId: input.machineId } : {})
                    })
                ),
            /**
             * COL-03 from outside: `Task.delegate` on the parent under the external principal (limits, depth, the
             * parent parked `waiting {child}`), then the child is placed by the router as the workspace driver — a child
             * already routed (a repeated `callId`) answers 409 there and is simply returned as it stands.
             */
            delegate: async (input) => {
                const callId = input.callId ?? `mcp_${crypto.randomUUID()}`;
                const childId = await task(input.taskId).delegate({
                    callId,
                    objective: input.objective,
                    assignee: input.agentId,
                    ...(input.context !== undefined ? { context: input.context } : {}),
                    ...(input.constraints !== undefined ? { constraints: input.constraints } : {}),
                    ...(input.environmentId !== undefined ? { environmentId: input.environmentId } : {}),
                    ...(input.machineId !== undefined ? { machineId: input.machineId } : {})
                });
                try {
                    await as(Routing, routingKey(workspaceId), driver).run(childId);
                } catch (e) {
                    if (!(isServerFnError(e) && e.status === 409)) throw e;
                }
                return summary(await task(childId).get());
            },
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
            history: (chatId, cursor, limit) => as(Chat, agentChatKey(workspaceId, chatId)).history(cursor, limit),
            fileAccess: (chatId, fileId) => as(Chat, agentChatKey(workspaceId, chatId)).fileAccess(fileId)
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
                    ...(input.machineId !== undefined ? { machineId: input.machineId } : {}),
                    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
                    ...(input.offlinePolicy !== undefined ? { offlinePolicy: input.offlinePolicy } : {})
                });
                return { scheduleId: view.id, title: view.title, kind: view.kind, enabled: view.enabled, next: view.next };
            }
        },
        projects: {
            // The catalogue is the Workspace's (owner-only, read as the driver like the machine index); the chat decides the set under the client (#334).
            list: async () =>
                (await workspace().projects()).map((p) => ({
                    id: p.id,
                    name: p.name,
                    ...(p.description !== undefined ? { description: p.description } : {}),
                    ...projectFolderPlaces(p.folders)
                })),
            setChatProject: async (chatId, projectId) => {
                await as(Chat, agentChatKey(workspaceId, chatId)).setProject(projectId);
            },
            setChatMachine: async (chatId, machineId) => {
                await as(Chat, agentChatKey(workspaceId, chatId)).setMachine(machineId);
            }
        },
        plan: {
            list: async (projectId, planId) => inPlan((await (await planOf(projectId)).client.list()).plans, planId),
            async next(projectId, agentId, planId) {
                const { client } = await planOf(projectId);
                const item = await client.next(agentId);
                if (item === null || planId === undefined) return item;
                // The actor picks across every plan; one named plan narrows the answer, never widens it.
                return inPlan((await client.list()).plans, planId).some((p) => p.phases.some((ph) => ph.items.some((i) => i.id === item.id))) ? item : null;
            },
            async claim(projectId, item, agentId, leaseMs) {
                const { project } = await planOf(projectId);
                if (!project.members.agentIds.includes(agentId)) throw new ServerFnError(403, `agent ${agentId} is not a member of project ${projectId}`);
                // Only an agent claims, for itself: the claim is made as that agent, in a session named for this client.
                const agent = mintAgentPrincipal({ workspaceId, agentId, sessionId: `mcp_${clientId}` as SessionId });
                const out = await (as(PlanStore, planKey(workspaceId, projectId), agent) as unknown as PlanActorClient).claim(item, { leaseMs });
                return out.item;
            },
            async assign(projectId, item, to, index) {
                const { client, people } = await planOf(projectId);
                return client.assign(item, resolvePlanMember(people, to), index);
            },
            update: async (projectId, item, update) => (await planOf(projectId)).client.update(item, planPatch(update)),
            after: async (projectId, item, after) => (await planOf(projectId)).client.after(item, after),
            async ref(projectId, item, ref) {
                // No session, so no folder to pin a file ref in: it is stored as given.
                await (await planOf(projectId)).client.ref(item, ref);
                return ref;
            },
            add: async (projectId, input) => planAdd((await planOf(projectId)).client, input),
            async handoff(projectId, item, to, note) {
                const { client, people } = await planOf(projectId);
                const target = to !== undefined ? resolvePlanMember(people, to) : planHandoffTarget(people, (await client.list()).plans, item, undefined);
                return client.handoff(item, target, note);
            }
        },
        requests: {
            list: async (projectId, state) => (await requestsOf(projectId).incoming()).filter((r) => state === undefined || r.state === state),
            async triage(projectId, requestId, triage) {
                const project = (await workspace().projects()).find((p) => p.id === projectId);
                if (!project) throw new ServerFnError(404, `no project ${projectId} in this workspace`);
                const manager = projectManagerOf(project);
                if (!manager) throw new ServerFnError(409, `project ${projectId} has no project manager to triage its requests`);
                // Triage is the manager's: made as that agent, in a session named for this client (as a claim is).
                return requestsOf(projectId, mintAgentPrincipal({ workspaceId, agentId: manager, sessionId: `mcp_${clientId}` as SessionId })).triage(requestId, triage);
            },
            resolve: (projectId, requestId, resolution) => requestsOf(projectId).resolve(requestId, actorResolution(resolution)),
            send: (input) =>
                requestsOf(input.toProject).send({
                    fromProject: input.fromProject,
                    ...(input.fromChat !== undefined ? { fromChat: input.fromChat } : {}),
                    title: input.title,
                    body: input.body,
                    refs: input.refs
                })
        },
        usage: {
            // The tool gate already checked the `usage` scope; the machines are read as the workspace driver, so a client granted
            // `usage` alone sees the accounts' limits without `machines` (the answer carries no more than `usage_limits` names).
            limits: async (query) => {
                const views = query.machineId !== undefined ? [await machine(query.machineId, driver).get()] : await machines(driver);
                return usageLimitsOf(views, query, Date.now());
            }
        }
    };
}
