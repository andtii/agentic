/**
 * Where the Plan views read from (#754): on mock data the plans in `mock/projects/plan.ts`; live, none until the Plan
 * store (the Plan actor, #750) exists — the views then say so. Also how a plan names its actors and what "now" is.
 */
import type { PlanActor } from '@agentic/core';
import type { AgentHue } from '@agentic/ui';
import { dataMode } from '../../../../../data-mode';
import { MOCK_PLANS, MOCK_PLAN_VIEWER } from '../../../../../mock/projects/plan';
import { AGENTS, MOCK_NOW, USER } from '../../../../../mock/workspace';
import type { PlanDoc } from './model';

/** A project's plans: `[]` live until the Plan store exists (#750). */
export const plansOf = (projectId: string): readonly PlanDoc[] => (dataMode() === 'live' ? [] : (MOCK_PLANS[projectId] ?? []));

/** Who "Mine" and "You" are. */
export const planViewer = (): PlanActor => MOCK_PLAN_VIEWER;

/** The clock leases and ages count from. */
export const planNow = (): number => (dataMode() === 'live' ? Date.now() : MOCK_NOW);

export interface PlanActorLook {
    readonly name: string;
    readonly hue?: AgentHue;
    readonly person: boolean;
    /** The tile's monogram when it is not the name's (you: your initials, labelled "You"). */
    readonly monogram?: string;
}

const initials = (name: string): string => name.slice(0, 2).toUpperCase();

/** How an actor is drawn: an agent by its name and hue, the viewer as "You", another person by their id. */
export function actorLook(a: PlanActor, me: PlanActor = planViewer()): PlanActorLook {
    if (a.kind === 'user') return a.userId === (me.kind === 'user' ? me.userId : '') ? { name: 'You', person: true, monogram: initials(USER.name) } : { name: a.userId, person: true };
    const agent = AGENTS.find((x) => x.id === a.agentId);
    return agent ? { name: agent.name, hue: agent.hue, person: false } : { name: a.agentId, person: false };
}

export const actorName = (a: PlanActor): string => actorLook(a).name;
