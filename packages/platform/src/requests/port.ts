/**
 * The Requests actor as the request tools see it (#930; PRJ-15): a pure mapping from the actor's methods
 * (`defineRequestsActor`, #758) onto the runtimes' `RequestsPort` (#759), mirroring the Plan port (#816).
 *
 * The port owns no actor and no principal: `scope(call)` names the session's project and hands it the workspace's
 * projects (members, manager, policy); `requests(projectId)` is that project's Requests client, already bound to the
 * caller (the session's agent). Reading the board is `incoming()`; triage and resolve go to the session's own project,
 * a send to the target's — and every refusal of the actor comes back unchanged. The manager is the actor's own rule
 * (`pm.agentId`, else the coordinator), so the tools' early refusals and the actor's checks agree.
 */
import type { AgentId, ChatId, ProjectId, ProjectRecord, Triage } from '@agentic/core';
import type { NewRequest, RequestsBoard, RequestsPort, RequestTarget, RequestResolution as ToolResolution, ToolCall } from '@agentic/runtimes';
import { projectManagerOf } from '../chat/participants-visiting.js';
import { pmPolicyOf } from '../workspace/pm-policy.js';
import type { RequestInput, RequestResolution, RequestView } from './rules.js';

/** The Requests actor methods the port calls; a client of `defineRequestsActor()` satisfies it. */
export interface RequestsActorClient {
    incoming(): Promise<readonly RequestView[]>;
    triage(id: string, triage: Triage): Promise<RequestView>;
    resolve(id: string, resolution: RequestResolution): Promise<RequestView>;
    send(input: RequestInput): Promise<RequestView>;
}

/** The project fields the port reads. */
export type RequestsProject = Pick<ProjectRecord, 'id' | 'name' | 'members' | 'pm'>;

/** One call's view: the session's project and the workspace's projects. */
export interface RequestsScope {
    readonly projectId: ProjectId;
    readonly projects: readonly RequestsProject[];
    /** The chat the session belongs to — a send records it as `fromChat`, with its title when known. */
    readonly chat?: { readonly id: ChatId; readonly title?: string };
}

export interface RequestsPortDeps {
    /** The agent the session runs as. */
    readonly me: AgentId;
    /** The session's project for this call; throws when the session has none (the tool then shows why). */
    scope(call: ToolCall): Promise<RequestsScope>;
    /** A project's Requests actor, bound to the caller. */
    requests(projectId: ProjectId): RequestsActorClient | Promise<RequestsActorClient>;
}

/** Whether `agentId` belongs to `project`: an agent member, its coordinator or its manager. */
export function requestsMember(project: RequestsProject, agentId: AgentId): boolean {
    return project.members.agentIds.includes(agentId) || project.members.coordinator === agentId || project.pm?.agentId === agentId;
}

/** The tools' resolution as the actor's (`ask-for-more` is the actor's `ask`). */
export function actorResolution(resolution: ToolResolution): RequestResolution {
    if (resolution.action === 'ask-for-more') return { action: 'ask', question: resolution.question };
    return resolution;
}

/** The runtimes' `RequestsPort` over the Requests actor (#930). */
export function createRequestsPort(deps: RequestsPortDeps): RequestsPort {
    const { me } = deps;

    async function home(call: ToolCall): Promise<{ readonly scope: RequestsScope; readonly project: RequestsProject }> {
        const scope = await deps.scope(call);
        const project = scope.projects.find((p) => p.id === scope.projectId);
        if (!project) throw new Error(`requests: project ${scope.projectId} no longer exists`);
        return { scope, project };
    }

    return {
        async board(call): Promise<RequestsBoard> {
            const { project } = await home(call);
            const manager = projectManagerOf(project);
            const requests = await (await deps.requests(project.id)).incoming();
            return { project: project.id, me, member: requestsMember(project, me), ...(manager ? { manager } : {}), policy: pmPolicyOf(project), requests };
        },
        async target(projectId, call): Promise<RequestTarget | null> {
            const { scope } = await home(call);
            const p = scope.projects.find((x) => x.id === projectId);
            if (!p) return null;
            return { project: p.id, name: p.name, policy: pmPolicyOf(p), hasManager: projectManagerOf(p) !== null };
        },
        async triage(requestId, triage, call) {
            const { project } = await home(call);
            return (await deps.requests(project.id)).triage(requestId, triage);
        },
        async resolve(requestId, resolution, call) {
            const { project } = await home(call);
            return (await deps.requests(project.id)).resolve(requestId, actorResolution(resolution));
        },
        async send(input: NewRequest, call) {
            const { scope, project } = await home(call);
            const chat = scope.chat;
            return (await deps.requests(input.toProject)).send({
                fromProject: project.id,
                ...(chat ? { fromChat: chat.id, ...(chat.title ? { fromChatTitle: chat.title } : {}) } : {}),
                title: input.title,
                body: input.body,
                refs: input.refs
            });
        }
    };
}
