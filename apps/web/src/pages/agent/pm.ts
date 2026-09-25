/**
 * Which project an agent manages (#842): every project's manager is an agent
 * (`ProjectRecord.pm.agentId`, #784), so the Agents roster and the agent page
 * header name its project — a PM is not mistaken for a general agent. Pure:
 * the live pages feed it `Workspace.projects()`, the mock pages the sample
 * workspace with a manager on docs-site.
 */
import type { ProjectRecord } from '@agentic/core';
import { PM_POLICY_DEFAULT } from '@agentic/core';
import { PROJECTS } from '../../mock/workspace';

/** The project a manager agent belongs to. */
export interface PmProject {
    readonly id: string;
    readonly name: string;
}

/** Agent id → the project it manages; an agent managing several keeps the first, in creation order. */
export function pmProjectsOf(projects: readonly ProjectRecord[]): ReadonlyMap<string, PmProject> {
    const out = new Map<string, PmProject>();
    for (const p of projects) {
        const agentId = p.pm?.agentId;
        if (agentId && !out.has(agentId)) out.set(agentId, { id: p.id, name: p.name });
    }
    return out;
}

/** The mock workspace's projects with docs-site managed by Scout (`a1`), so `pnpm dev:mock` shows a PM chip. */
export const mockPmProjects = (): ReadonlyMap<string, PmProject> =>
    pmProjectsOf(PROJECTS.map((p) => (p.id === 'p_docs' && !p.pm ? { ...p, pm: { agentId: 'a1' as never, policy: PM_POLICY_DEFAULT } } : p)));
