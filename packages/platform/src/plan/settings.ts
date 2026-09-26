/**
 * The Plan feature's project settings as the Plan actor enforces them (#938; `@agentic/plugins-plan`'s
 * `planProjectSettings`): `claimLimit` (items per agent at once, a member's own `members.limits` entry overriding it),
 * `leaseMinutes` (the lease a claim gets unless the agent asks for another), `agentsMayTick` (may an agent tick
 * done-when lines and mark an item done) and `starter` (the template a new plan without phases starts from).
 *
 * Read from `features['agentic.feature.plan']` on the project record; a value that is missing or out of range falls
 * back to the schema's default, so a project without the feature (or with an old record) behaves as before.
 */
import { MEMBER_LIMIT_MAX, memberLimit, PLAN_LEASE_DEFAULT_MS, type AgentId, type ProjectRecord } from '@agentic/core';
import { PLAN_FEATURE_ID, PLAN_TEMPLATES, type PlanTemplate } from '@agentic/plugins-plan';

/** The settings the rules read, defaults filled in. */
export interface PlanSettings {
    readonly claimLimit: number;
    readonly leaseMs: number;
    readonly agentsMayTick: boolean;
    /** The starter template, when the project names one that exists. */
    readonly starter?: PlanTemplate;
}

/** The schema's bounds (`planProjectSettings`). */
const LEASE_MINUTES_MIN = 5;
const LEASE_MINUTES_MAX = 480;

const intIn = (value: unknown, min: number, max: number): number | undefined => (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : undefined);

/** The Plan settings of `project` (absent: every default). */
export function planSettings(project: Partial<Pick<ProjectRecord, 'features'>> | undefined): PlanSettings {
    const raw = project?.features?.[PLAN_FEATURE_ID] ?? {};
    const minutes = intIn(raw['leaseMinutes'], LEASE_MINUTES_MIN, LEASE_MINUTES_MAX);
    const starterId = raw['starter'];
    const starter = typeof starterId === 'string' && Object.hasOwn(PLAN_TEMPLATES, starterId) ? PLAN_TEMPLATES[starterId] : undefined;
    return {
        claimLimit: intIn(raw['claimLimit'], 1, MEMBER_LIMIT_MAX) ?? 1,
        leaseMs: minutes !== undefined ? minutes * 60_000 : PLAN_LEASE_DEFAULT_MS,
        agentsMayTick: raw['agentsMayTick'] !== false,
        ...(starter ? { starter } : {})
    };
}

/** How many items `agentId` may work on at once: its own `members.limits` entry, else the project's `claimLimit`. */
export function planLimitOf(project: Pick<ProjectRecord, 'members'> & Partial<Pick<ProjectRecord, 'features'>>, agentId: AgentId): number {
    const own = project.members.limits?.[agentId];
    if (typeof own === 'number' && Number.isInteger(own) && own >= 1) return memberLimit(project, agentId);
    return planSettings(project).claimLimit;
}
