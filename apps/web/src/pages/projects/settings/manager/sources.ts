/**
 * What Settings › Project manager (#760) reads and writes, on either data source. Live: the manager is
 * `AgentActor.get()` of `project.pm.agentId` (#784), its changes `Workspace.updateProjectManager` (a new config
 * version), a project without one gets it through `upsertProject({ pm })`; the other projects come from
 * `Workspace.projects()`, the agents' names from the chat directory. The policy saves through the settings tabs'
 * `useTabSave` (`upsertProject({ pmPolicy })`). On mock data the manager is the project's coordinator (or its
 * `pm.agentId`) with the first preset, and a change lands in `mockManagerSaves` and the page's copy.
 * `dataMode()` is fixed for an app, so each hook takes one branch for the life of the page.
 */
import { signal, watch } from 'sigx';
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
import { PM_PERSONALITIES, type ProjectId, type ProjectManagerSpec, type ProjectRecord } from '@agentic/core';
import type { AgentView } from '@agentic/platform';
import { useActorDefs, useViewer } from '../../../../actors/defs';
import { agentKeyOf, workspaceKeyOf } from '../../../../actors/keys';
import { dataMode } from '../../../../data-mode';
import { MOCK_PM_SKILLS } from '../../../../mock/projects/settings';
import { AGENTS, PROJECTS } from '../../../../mock/workspace';
import { saveProjectWith } from '../../LiveProjects';
import { useProjects } from '../../live';
import { useMembersSource } from '../general/sources';
import { personalityOfInstructions, type ManagerPatch, type PmAgent } from './model';

export interface ManagerSource {
    /** The project's manager; `null` when it has none (or the read has not landed). */
    agent(): PmAgent | null;
    readonly loading: boolean;
    /** Every project in the workspace, for the sender rules. */
    projects(): readonly Pick<ProjectRecord, 'id' | 'name'>[];
    nameOf(agentId: string): string;
    skillOptions(): readonly { readonly value: string; readonly label?: string }[];
    /** Change the manager: only the fields named. */
    update(patch: ManagerPatch): Promise<void>;
    /** Give a project without a manager one. */
    create(spec: ProjectManagerSpec): Promise<void>;
}

/** Every manager change on mock data, newest last. */
export const mockManagerSaves: { projectId: string; patch: ManagerPatch | ProjectManagerSpec }[] = [];

/** The live view of a manager agent. */
export function pmAgentOf(view: Pick<AgentView, 'id' | 'config'>): PmAgent {
    const c = view.config;
    const personality = personalityOfInstructions(c.instructions);
    return {
        id: view.id,
        name: c.name,
        runtime: c.execution?.runtime ?? '—',
        ...(personality ? { personality } : {}),
        skills: (c.skills ?? []).map((s) => s.id)
    };
}

function useMockSource(project: () => ProjectRecord): ManagerSource {
    const members = useMembersSource();
    const initial = (): PmAgent | null => {
        const p = project();
        const id = p.pm?.agentId ?? p.members.coordinator;
        const a = id ? AGENTS.find((x) => x.id === id) : undefined;
        return a ? { id: a.id, name: a.name, runtime: a.environment.runtime, personality: { preset: PM_PERSONALITIES[0]!.id }, skills: ['planning', 'triage'] } : null;
    };
    const st = signal({ agent: initial() });
    watch(() => project().id, () => { st.agent = initial(); });
    const agent = (): PmAgent | null => st.agent;
    return {
        agent,
        loading: false,
        projects: () => PROJECTS,
        nameOf: (id) => members.agents().find((a) => a.id === id)?.name ?? id,
        skillOptions: () => MOCK_PM_SKILLS,
        async update(patch) {
            const a = agent();
            if (!a) throw new Error('This project has no project manager.');
            mockManagerSaves.push({ projectId: project().id, patch });
            st.agent = {
                ...a,
                ...(patch.name !== undefined ? { name: patch.name } : {}),
                ...(patch.personality !== undefined ? { personality: patch.personality } : {}),
                ...(patch.skills !== undefined ? { skills: patch.skills.map((s) => s.id) } : {})
            };
        },
        async create(spec) {
            mockManagerSaves.push({ projectId: project().id, patch: spec });
            st.agent = { id: 'pm', name: spec.name ?? 'Nova', runtime: 'anthropic-api', personality: spec.personality, skills: spec.skills.map((s) => s.id) };
        }
    };
}

function useLiveSource(project: () => ProjectRecord): ManagerSource {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const members = useMembersSource();
    const projects = useProjects(defs, viewer);
    const view = useActorState(
        defs.AgentActor,
        () => {
            const ws = viewer.workspaceId;
            const id = project().pm?.agentId;
            return ws && id ? ([agentKeyOf(ws, id), 'get'] as const) : false;
        },
        { live: true }
    );
    const ws = (): string => {
        const id = viewer.workspaceId;
        if (!id) throw new Error('Sign in to change the project.');
        return id;
    };
    return {
        agent: () => (project().pm?.agentId && view.value ? pmAgentOf(view.value) : null),
        get loading() {
            return !!project().pm?.agentId && view.loading;
        },
        projects: () => projects.list(),
        nameOf: (id) => members.agents().find((a) => a.id === id)?.name ?? id,
        skillOptions: () => [],
        async update(patch) {
            await actor(defs.Workspace, workspaceKeyOf(ws())).updateProjectManager(project().id as ProjectId, patch);
        },
        async create(spec) {
            await saveProjectWith(defs, ws(), { id: project().id, pm: spec });
        }
    };
}

export const useManagerSource = (project: () => ProjectRecord): ManagerSource => (dataMode() === 'live' ? useLiveSource(project) : useMockSource(project));
