/**
 * The in-process half of the acceptance suite (docs/acceptance.md): the
 * app's OWN actor registry — `platformActors()` from `src/actors.app.ts`,
 * every port the production wiring — on an in-process host over memory
 * storage, with the `anthropic-api` runtime on the real local path
 * (`createSessionFactory` → `createPlatformModelAgent` over the platform
 * tool ports) driven by a scripted model, so `delegate`, `memory_search`
 * and the approval policy run exactly as they do with a real model.
 * Offline and deterministic. Scenarios that need Durable Objects (daemon
 * sockets, alarms) live in `*.workers.test.ts` instead.
 */
import type { AgentId, Principal, TaskContract, TaskId, WorkspaceId } from '@agentic/core';
import { AgentActor, TaskActor, Workspace, agentKey, createSessionFactory, importWorkspaceKek, sessionPolicy, taskKey, workspaceKey, type AgentConfigPatch, type MachineActor, type RoutingActor, type SessionActor, type SessionFactory, type TaskView } from '@agentic/platform';
import { mockModel, type MockModel } from '@sigx/ai/testing';
import type { ModelRequest } from '@sigx/ai';
import type { ActorClient, AnyActorDefinition } from '@sigx/actors';
import { testActorApp, userPrincipal, type PrincipalBinding, type TestActorApp } from '../../../../packages/platform/src/testing/index';
import { defaultPorts, platformActors, platformDefs, type PlatformPorts } from '../../src/actors.app';
import type { ActorDefs } from '../../src/actors/defs';
import { routingKeyOf } from '../../src/actors/keys';
import { TEST_WORKSPACE_KEK } from '../workers/secret';

export { userPrincipal, sessionPolicy };

/** The text of the last user message a model request carries. */
export function lastUserText(request: ModelRequest): string {
    const last = [...request.messages].reverse().find((m) => m.role === 'user');
    if (!last) return '';
    return typeof last.content === 'string' ? last.content : last.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
}

const hasTool = (request: ModelRequest, name: string): boolean => !!request.tools?.some((t) => t.name === name);
const answered = (request: ModelRequest): boolean => request.messages.some((m) => m.role === 'tool');

/**
 * One scripted model for every session, driven by the prompt text:
 * `delegate <agentId>: <objective>` calls the `delegate` tool once (call id
 * `d1`) and then reports; `search: <query>` calls `memory_search` once (`m1`)
 * and then answers; anything else is echoed.
 */
export function scriptedModel(): MockModel {
    return mockModel({
        modelId: 'claude-acceptance',
        respond: (request) => {
            const text = lastUserText(request);
            const delegate = /^delegate (\S+): ([\s\S]+)$/.exec(text);
            if (delegate && hasTool(request, 'delegate')) {
                return answered(request) ? { text: 'parent done' } : { toolCalls: [{ name: 'delegate', input: { assignee: delegate[1], objective: delegate[2] }, id: 'd1' }] };
            }
            if (text.startsWith('search:') && hasTool(request, 'memory_search')) {
                return answered(request) ? { text: `searched: ${text.slice(7).trim()}` } : { toolCalls: [{ name: 'memory_search', input: { query: text.slice(7).trim() }, id: 'm1' }] };
            }
            return { text: `echo: ${text}` };
        }
    });
}

export interface AcceptanceHost {
    readonly app: TestActorApp;
    readonly actors: readonly AnyActorDefinition[];
    /** The registry's definitions, picked by type — the same objects the host runs. */
    readonly defs: ActorDefs;
    readonly Machine: MachineActor;
    readonly Registry: AnyActorDefinition;
    readonly Schedule: AnyActorDefinition;
    /** The scripted model every local session ran on (its `requests` are what the runtime saw); absent with a custom `factory`. */
    readonly model?: MockModel;
    /** A binding whose every call carries `principal`. */
    as(principal: Principal | null): PrincipalBinding;
    /** One workspace owner and the clients the scenarios need. */
    user(userId: string): Owner;
    stop(): Promise<void>;
}

export interface Owner {
    readonly userId: string;
    readonly ws: WorkspaceId;
    readonly principal: Principal;
    workspace(): ActorClient<typeof Workspace>;
    agentActor(agentId: AgentId): ActorClient<typeof AgentActor>;
    task(taskId: string): ActorClient<typeof TaskActor>;
    session(sessionId: string): ActorClient<SessionActor>;
    routing(): ActorClient<RoutingActor>;
    /** An agent in the workspace index on the `anthropic-api` runtime, configured with `patch` on top of the defaults. */
    agent(name: string, patch?: AgentConfigPatch): Promise<AgentId>;
    createTask(id: string, assignee: AgentId, extra?: Partial<TaskContract>): Promise<TaskView>;
    /** Wait for the task to leave the running states; throws with the record on timeout. */
    settled(id: string): Promise<TaskView>;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll until `check()` holds. */
export async function until(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await sleep(5);
    }
}

/** The transitions of a task as `from>to` edges. */
export const edges = (t: TaskView): string[] => t.transitions.map((x) => `${x.from}>${x.to}`);

export interface StartHostOptions {
    /** The `anthropic-api` factory, given the Routing definition; default: the real local path over `scriptedModel()`. */
    readonly factory?: (routing: () => AnyActorDefinition) => SessionFactory;
    readonly ports?: Partial<PlatformPorts>;
}

const byType = (actors: readonly AnyActorDefinition[], type: string): AnyActorDefinition => {
    const def = actors.find((d) => (d as { type: string }).type === type);
    if (!def) throw new Error(`[acceptance] no \`${type}\` actor in the registry`);
    return def;
};

/** Start the app's registry on an in-process host. */
export async function startHost(options: StartHostOptions = {}): Promise<AcceptanceHost> {
    let actors: readonly AnyActorDefinition[] = [];
    const routing = () => byType(actors, 'routing');
    const model = options.factory ? undefined : scriptedModel();
    const factory = options.factory ? options.factory(routing) : createSessionFactory({ routing, model: model! });
    actors = platformActors({ ...defaultPorts, factory, kek: () => importWorkspaceKek(TEST_WORKSPACE_KEK), channels: [], ...options.ports });
    const app = testActorApp(actors);
    await app.start();
    const defs = platformDefs(actors);
    const host: AcceptanceHost = {
        app,
        actors,
        defs,
        Machine: byType(actors, 'machine') as MachineActor,
        Registry: byType(actors, 'Registry'),
        Schedule: byType(actors, 'Schedule'),
        ...(model ? { model } : {}),
        as: (principal) => app.as(principal),
        user(userId) {
            const ws = userId as WorkspaceId;
            const principal = userPrincipal(userId);
            const me = app.as(principal);
            const task = (id: string) => me.actor(TaskActor, taskKey(ws, id as TaskId));
            return {
                userId,
                ws,
                principal,
                workspace: () => me.actor(Workspace, workspaceKey(ws)),
                agentActor: (agentId) => me.actor(AgentActor, agentKey(ws, agentId)),
                task,
                session: (sessionId) => me.actor(defs.Session as SessionActor, `${ws}:session:${sessionId}`),
                routing: () => me.actor(defs.Routing as RoutingActor, routingKeyOf(ws)),
                async agent(name, patch = {}) {
                    const { agentId } = await me.actor(Workspace, workspaceKey(ws)).createAgent({ name });
                    await me.actor(AgentActor, agentKey(ws, agentId)).update({ name, instructions: 'Be brief.', execution: { runtime: 'anthropic-api', offlinePolicy: 'fail' }, ...patch }, 'create');
                    return agentId;
                },
                createTask: (id, assignee, extra = {}) => task(id).create({ objective: `do ${id}`, origin: { kind: 'external', clientId: 'acceptance' }, assignee, context: [], constraints: {}, ...extra }, { owner: assignee }),
                async settled(id) {
                    const done = (t: TaskView) => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled';
                    try {
                        await until(async () => done(await task(id).get()), `task ${id} to settle`);
                    } catch (e) {
                        const t = await task(id).get();
                        throw new Error(`${(e as Error).message}\n${JSON.stringify({ status: t.status, wait: t.wait, error: t.error, transitions: t.transitions }, null, 1)}`);
                    }
                    return task(id).get();
                }
            };
        },
        stop: () => app.stop()
    };
    return host;
}
