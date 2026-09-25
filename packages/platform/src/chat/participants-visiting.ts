/**
 * Visiting project managers in a chat (#762; PRJ-16; docs/design/projects/HANDOFF.md → "Project manager and requests",
 * board `PMChat`). Another project's manager joins a chat by `@` mention: it becomes an ordinary agent member of the
 * chat (`Chat.addAgent`, history from now), and is a **visitor** because it manages a project that is not the chat's.
 * Its messages and its member card carry its project and `project manager, visiting`.
 *
 * The requests a chat started (`ProjectRequest.fromChat`) read back into it: a request card that follows the request's
 * state in place (`ACCEPTED → SIGNALX#14`), the accept as a divider, the plan item it became as a result card, and the
 * **Across projects** list of the items the chat links — the filed item and the chat project's items it names.
 *
 * Pure except `bringInVisitors`, which only calls the chat client it is handed; edge-safe.
 */
import type { AgentId, ChatId, HistoryAccess, ProjectId, ProjectRecord, ProjectRequest, RequestState } from '@agentic/core';

/** What a visiting manager's messages and member card say under its name. */
export const VISITING_ROLE = 'project manager, visiting';

/** The project fields visiting reads. */
export type VisitingProject = Pick<ProjectRecord, 'id' | 'name' | 'members' | 'pm'> & Partial<Pick<ProjectRecord, 'color'>>;

/** A manager visiting a chat from its own project. */
export interface Visitor {
    readonly agentId: AgentId;
    readonly projectId: ProjectId;
    readonly projectName: string;
    readonly role: typeof VISITING_ROLE;
}

/** A project's manager: `pm.agentId`, else its coordinator (the Requests actor's rule). */
export function projectManagerOf(project: Pick<ProjectRecord, 'members' | 'pm'>): AgentId | null {
    return project.pm?.agentId ?? project.members.coordinator ?? null;
}

/**
 * Every manager that would visit a chat in `chatProjectId`: the managers of the other projects, minus the agents that
 * belong to the chat's project (a member there is at home, not visiting). A chat outside any project has no home to
 * visit, so no one visits it — nor one whose project was removed.
 */
export function visitingManagers(projects: readonly VisitingProject[], chatProjectId: ProjectId | null | undefined): Visitor[] {
    if (!chatProjectId) return [];
    const home = projects.find((p) => p.id === chatProjectId);
    // A chat can keep the id of a project since removed: with no home, no one visits.
    if (!home) return [];
    const locals = new Set<string>([...home.members.agentIds, ...(home.members.coordinator ? [home.members.coordinator] : []), ...(home.pm?.agentId ? [home.pm.agentId] : [])]);
    const out: Visitor[] = [];
    for (const p of projects) {
        if (p.id === chatProjectId) continue;
        const agentId = projectManagerOf(p);
        if (!agentId || locals.has(agentId) || out.some((v) => v.agentId === agentId)) continue;
        out.push({ agentId, projectId: p.id, projectName: p.name, role: VISITING_ROLE });
    }
    return out;
}

/** The chat's members that are visiting, in member order. */
export function visitorsIn(memberIds: readonly string[], projects: readonly VisitingProject[], chatProjectId: ProjectId | null | undefined): Visitor[] {
    const managers = visitingManagers(projects, chatProjectId);
    return memberIds.flatMap((id) => managers.filter((v) => v.agentId === id));
}

/** The visitor a member is, if it is one. */
export function visitorOf(agentId: string, projects: readonly VisitingProject[], chatProjectId: ProjectId | null | undefined): Visitor | undefined {
    return visitingManagers(projects, chatProjectId).find((v) => v.agentId === agentId);
}

/** The managers a message mentions that are not members yet: who it brings in. */
export function visitorsToBringIn(mentioned: readonly string[], memberIds: readonly string[], projects: readonly VisitingProject[], chatProjectId: ProjectId | null | undefined): Visitor[] {
    const members = new Set(memberIds);
    const managers = visitingManagers(projects, chatProjectId);
    const out: Visitor[] = [];
    for (const id of mentioned) {
        const v = managers.find((m) => m.agentId === id);
        if (v && !members.has(id) && !out.includes(v)) out.push(v);
    }
    return out;
}

/** The one Chat method bringing a visitor in needs. */
export interface VisitingChat {
    addAgent(agentId: AgentId, access?: HistoryAccess): Promise<unknown>;
}

/**
 * Add every manager `mentioned` that is not a member yet, history from now (a visitor reads the chat from the moment
 * it is brought in, CHT-04). Returns who was brought in; call it before posting, so the message activates them.
 */
export async function bringInVisitors(chat: VisitingChat, mentioned: readonly string[], memberIds: readonly string[], projects: readonly VisitingProject[], chatProjectId: ProjectId | null | undefined): Promise<Visitor[]> {
    const visitors = visitorsToBringIn(mentioned, memberIds, projects, chatProjectId);
    for (const v of visitors) await chat.addAgent(v.agentId, 'from-now');
    return visitors;
}

// ---------------------------------------------------------------------------
// Requests in the chat

/** The requests this chat started, oldest first — the order their cards appear in the thread. */
export function chatRequests<R extends ProjectRequest>(requests: readonly R[], chatId: ChatId | string): R[] {
    const seen = new Set<string>();
    return requests
        .filter((r) => r.fromChat === chatId && !seen.has(`${r.toProject} ${r.id}`) && seen.add(`${r.toProject} ${r.id}`))
        .sort((a, b) => a.createdAt - b.createdAt);
}

/** `signalx#14`: an item of a project, by the project's name. */
export const projectItemRef = (projectName: string, n: number): string => `${projectName.toLowerCase()}#${n}`;

/** The request card's state pill as the chat draws it: the target's pill words, `ACCEPTED → SIGNALX#14` once filed. */
export function requestCardState(request: Pick<ProjectRequest, 'state' | 'resultItem'>, toProjectName: string, managerName: string): { readonly label: string; readonly state: RequestState } {
    const label: Record<RequestState, string> = {
        'needs-you': 'NEEDS YOU',
        triaging: `${managerName.toUpperCase()} TRIAGING`,
        'asked-for-more': 'ASKED FOR MORE',
        accepted: request.resultItem !== undefined ? `ACCEPTED → ${projectItemRef(toProjectName, request.resultItem).toUpperCase()}` : 'ACCEPTED',
        declined: 'DECLINED'
    };
    return { label: label[request.state], state: request.state };
}

/** How a linked item stands, as the Across projects card reads it. */
export type AcrossState = 'filed' | 'waits' | 'open';

/** One item the chat links across projects. */
export interface AcrossItem {
    /** `signalx#14`. */
    readonly ref: string;
    readonly projectId?: ProjectId;
    readonly n: number;
    readonly state: AcrossState;
}

/**
 * The Across projects card: each request's filed item (`signalx#14`, filed), and every item of the chat's own project
 * a request names (`agentic#16`: waits while the request is open or filed, open again once it is declined). Newest
 * request first; each ref once.
 */
export function acrossProjects(requests: readonly ProjectRequest[], projects: readonly Pick<ProjectRecord, 'id' | 'name'>[], chatProjectId: ProjectId | null | undefined): AcrossItem[] {
    const nameOf = (id: ProjectId): string => projects.find((p) => p.id === id)?.name ?? id;
    const home = chatProjectId ? projects.find((p) => p.id === chatProjectId)?.name.toLowerCase() : undefined;
    const out: AcrossItem[] = [];
    const add = (item: AcrossItem): void => {
        if (!out.some((x) => x.ref === item.ref)) out.push(item);
    };
    for (const r of [...requests].sort((a, b) => b.updatedAt - a.updatedAt)) {
        if (r.state === 'accepted' && r.resultItem !== undefined) add({ ref: projectItemRef(nameOf(r.toProject), r.resultItem), projectId: r.toProject, n: r.resultItem, state: 'filed' });
        const waiting = r.state !== 'declined';
        for (const ref of r.refs) {
            if (ref.kind !== 'project-item' || ref.project.toLowerCase() !== home) continue;
            add({ ref: projectItemRef(ref.project, ref.n), ...(chatProjectId ? { projectId: chatProjectId } : {}), n: ref.n, state: waiting ? 'waits' : 'open' });
        }
    }
    return out;
}
