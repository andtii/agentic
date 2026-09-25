/**
 * The project manager agent (#784; PRJ-14): every project gets its own manager, a real agent with a personality
 * and skills, created with the project. It runs on the platform runtime so it answers with every machine off.
 *
 * Pure helpers only: the Workspace actor (`createProjectManager`, `updateProjectManager`, `upsertProject`) holds
 * the index and hops to the Agent actor with the config built here.
 */

import type { AgentConfig, AgentId, ProjectId, ProjectManagerSpec, ProjectRecord, SkillRef, ToolGrant } from '@agentic/core';
import { PLAN_TOOLS, PM_PERSONALITIES, PM_POLICY_DEFAULT, pmPersonalityText, REQUEST_TOOLS } from '@agentic/core';
import type { AgentConfigPatch } from '../agent/config.js';
import { defaultAgentConfig } from '../agent/config.js';

/** The role every project manager agent carries: what the Agents page shows beside its project. */
export const PM_ROLE = 'Project manager';

/** A manager's name is one line of at most this many characters. */
export const MAX_PM_NAME_LENGTH = 60;

/** At most this many skills on a manager. */
export const MAX_PM_SKILLS = 32;

/** The fixed playbook every project manager starts its instructions with; the personality follows it. */
export const PM_PLAYBOOK = [
    'You are the project manager of this project. Your job:',
    '- Own the Plan: keep its phases and items current, with a clear done-when on every item.',
    "- Assign by queue and limit: give work to members in their queue order, never above a member's working limit.",
    '- Triage requests from other projects: judge the kind and priority, reproduce what you can, link similar items, propose an item, and reply to the sender.',
    '- Keep the person in the loop: say what changed and what needs them, briefly, and ask when the policy says to.',
    '- Never raise a priority above what the policy lets you set alone: high and urgent always go to a person.'
].join('\n');

/** The spec a new project's manager starts from when the patch names none: the first preset, no skills. */
export const DEFAULT_PM_SPEC: ProjectManagerSpec = { personality: { preset: PM_PERSONALITIES[0]!.id }, skills: [] };

/** Names the platform suggests for a manager the spec leaves unnamed. */
export const PM_NAME_SUGGESTIONS = ['Nova', 'Atlas', 'Iris', 'Juno', 'Orion', 'Vega', 'Lyra', 'Sage'] as const;

/** A stable suggestion for `projectId`: the same project always gets the same name. */
export function suggestPmName(projectId: string): string {
    let h = 0;
    for (let i = 0; i < projectId.length; i++) h = (h * 31 + projectId.charCodeAt(i)) >>> 0;
    return PM_NAME_SUGGESTIONS[h % PM_NAME_SUGGESTIONS.length]!;
}

/** The tools a manager is granted: the `plan_*` and `requests_*` families, and `projects_request`. */
export function pmTools(): ToolGrant[] {
    return [...PLAN_TOOLS, ...REQUEST_TOOLS].map((name) => ({ name }));
}

/** The playbook, then the personality paragraph. */
export function pmInstructions(personality: string): string {
    return `${PM_PLAYBOOK}\n\n## Personality\n\n${personality}`;
}

/** Thrown for a spec or patch the platform refuses; the Workspace answers it with a 400. */
export class PmSpecError extends Error {}

function checkedName(name: unknown): string | undefined {
    if (name === undefined) return undefined;
    if (typeof name !== 'string') throw new PmSpecError('the project manager name must be text');
    const text = name.replace(/\s+/g, ' ').trim();
    if (text.length > MAX_PM_NAME_LENGTH) throw new PmSpecError(`the project manager name is longer than ${MAX_PM_NAME_LENGTH} characters`);
    return text || undefined;
}

function checkedSkills(skills: unknown): SkillRef[] {
    if (!Array.isArray(skills)) throw new PmSpecError('the project manager skills must be an array');
    if (skills.length > MAX_PM_SKILLS) throw new PmSpecError(`a project manager has at most ${MAX_PM_SKILLS} skills`);
    const out: SkillRef[] = [];
    for (const s of skills as unknown[]) {
        const ref = s as Partial<SkillRef> | null;
        if (ref === null || typeof ref !== 'object' || typeof ref.id !== 'string' || !ref.id.trim()) throw new PmSpecError('every skill needs an id');
        if (ref.version !== undefined && typeof ref.version !== 'string') throw new PmSpecError(`the version of skill ${ref.id} must be text`);
        const id = ref.id.trim();
        if (!out.some((x) => x.id === id)) out.push({ id, ...(ref.version !== undefined ? { version: ref.version } : {}) });
    }
    return out;
}

function checkedPersonality(spec: Pick<ProjectManagerSpec, 'personality'>): string {
    const p = spec.personality as unknown;
    if (p === null || typeof p !== 'object') throw new PmSpecError('the project manager needs a personality: { preset } or { custom }');
    const text = pmPersonalityText(spec);
    if (text === undefined) {
        const preset = (p as { preset?: unknown }).preset;
        throw new PmSpecError(preset !== undefined ? `no personality preset ${String(preset)}: use one of ${PM_PERSONALITIES.map((x) => x.id).join(', ')}` : 'the custom personality is empty');
    }
    return text;
}

/** `spec` as the platform keeps it: name one line or absent, skills one per id, a personality it can write. Throws `PmSpecError`. */
export function checkedPmSpec(spec: unknown): ProjectManagerSpec {
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) throw new PmSpecError('the project manager spec must be { name?, personality, skills }');
    const s = spec as ProjectManagerSpec;
    checkedPersonality(s);
    const name = checkedName(s.name);
    return { ...(name !== undefined ? { name } : {}), personality: s.personality, skills: checkedSkills(s.skills ?? []) };
}

/**
 * The manager's `AgentConfig` for `project` (pure): role `Project manager`, the spec's name (a suggestion when
 * none), the playbook then the personality, the spec's skills, the plan and requests tools, the platform runtime,
 * and the project's other members as collaborators. Throws `PmSpecError` for a spec it cannot write.
 */
export function projectManagerConfig(project: Pick<ProjectRecord, 'id' | 'name' | 'members' | 'pm'>, spec: ProjectManagerSpec): AgentConfig {
    const checked = checkedPmSpec(spec);
    const base = defaultAgentConfig();
    const self = project.pm?.agentId;
    return {
        ...base,
        name: checked.name ?? suggestPmName(project.id),
        description: `Project manager of ${project.name}`,
        role: PM_ROLE,
        instructions: pmInstructions(checkedPersonality(checked)),
        skills: checked.skills,
        tools: pmTools(),
        execution: { ...base.execution, runtime: 'anthropic-api' },
        collaborators: project.members.agentIds.filter((id) => id !== self)
    };
}

/** What `updateProjectManager` takes: any of the spec's fields. */
export type ProjectManagerPatch = Partial<ProjectManagerSpec>;

/** The Agent config patch for `patch` — only the fields it names. Throws `PmSpecError` for an empty or bad patch. */
export function projectManagerConfigPatch(patch: unknown): AgentConfigPatch {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw new PmSpecError('the patch must be { name?, personality?, skills? }');
    const p = patch as ProjectManagerPatch;
    const out: { name?: string; instructions?: string; skills?: SkillRef[] } = {};
    if (p.name !== undefined) {
        const name = checkedName(p.name);
        if (name === undefined) throw new PmSpecError('the project manager name cannot be empty');
        out.name = name;
    }
    if (p.personality !== undefined) out.instructions = pmInstructions(checkedPersonality({ personality: p.personality }));
    if (p.skills !== undefined) out.skills = checkedSkills(p.skills);
    if (Object.keys(out).length === 0) throw new PmSpecError('the patch changes nothing: give a name, personality or skills');
    return out;
}

/** `project` with `agentId` as its manager: a member, the coordinator, and `pm.agentId` (the policy kept, or the default). */
export function withProjectManager(project: ProjectRecord, agentId: AgentId): ProjectRecord {
    const agentIds = project.members.agentIds.includes(agentId) ? [...project.members.agentIds] : [...project.members.agentIds, agentId];
    return { ...project, members: { ...project.members, agentIds, coordinator: agentId }, pm: { policy: project.pm?.policy ?? PM_POLICY_DEFAULT, agentId } };
}

/** The project `agentId` is the manager of, if any. */
export function projectManagedBy(projects: readonly ProjectRecord[], agentId: AgentId): ProjectRecord | undefined {
    return projects.find((p) => p.pm?.agentId === agentId);
}

/** Why `coordinator` cannot coordinate project `projectId` (absent for a new one): it is another project's manager. */
export function pmCoordinatorError(projects: readonly ProjectRecord[], projectId: ProjectId | undefined, coordinator: AgentId | null): string | undefined {
    if (coordinator === null) return undefined;
    const managed = projectManagedBy(projects, coordinator);
    if (!managed || managed.id === projectId) return undefined;
    return `${coordinator} is the project manager of ${managed.name}; a project manager manages one project`;
}
