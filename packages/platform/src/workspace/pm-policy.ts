/**
 * The project manager's policy, checked (#758; PRJ-14/PRJ-15): who may send the project requests and what its manager
 * may do without asking a person. Pure — `Workspace.setProjectPmPolicy` stores what it returns, and the Requests actor
 * reads a stored policy back through `pmPolicyOf` (the default when a project has none, or an unreadable one).
 */
import { PM_POLICY_DEFAULT, REQUEST_PRIORITIES, type AgentId, type PlanActor, type PmAutonomy, type PmPolicy, type PmPriorityCap, type PmSenderRule, type PmWeeklySummary, type ProjectId, type ProjectRecord } from '@agentic/core';
import { PmSpecError } from './project-manager.js';

/** The most sender rules a policy holds, and listed senders per rule. */
export const PM_SENDER_RULES_MAX = 100;
export const PM_SENDERS_PER_RULE_MAX = 100;

const fail = (message: string): never => {
    throw new PmSpecError(message);
};

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function checkedActor(value: unknown): PlanActor {
    if (isObject(value) && value.kind === 'agent' && typeof value.agentId === 'string' && value.agentId.trim() && value.agentId.length <= 200) return { kind: 'agent', agentId: value.agentId.trim() as AgentId };
    if (isObject(value) && value.kind === 'user' && typeof value.userId === 'string' && value.userId.trim() && value.userId.length <= 200) return { kind: 'user', userId: value.userId.trim() };
    return fail('a listed sender is {kind: "agent", agentId} or {kind: "user", userId}');
}

function checkedRule(value: unknown): PmSenderRule {
    if (!isObject(value)) return fail('a sender rule is { project, who, mode }');
    const project = value.project;
    if (typeof project !== 'string' || !project.trim() || project.length > 200) fail('a sender rule names a project id or "*"');
    const mode = value.mode;
    if (mode !== 'allowed' && mode !== 'ask') fail('a sender rule mode is "allowed" or "ask"');
    const who = value.who;
    let checkedWho: PmSenderRule['who'];
    if (who === 'any-member') checkedWho = 'any-member';
    else if (Array.isArray(who)) {
        if (who.length > PM_SENDERS_PER_RULE_MAX) fail(`a sender rule lists at most ${PM_SENDERS_PER_RULE_MAX} senders`);
        checkedWho = who.map(checkedActor);
    } else return fail('a sender rule\'s who is "any-member" or a list of senders');
    return { project: project as ProjectId | '*', who: checkedWho, mode: mode as PmSenderRule['mode'] };
}

function flag(value: unknown, what: string): boolean {
    if (typeof value !== 'boolean') fail(`autonomy.${what} must be true or false`);
    return value as boolean;
}

function checkedAutonomy(value: unknown): PmAutonomy {
    if (!isObject(value)) return fail('autonomy is { addItems, assign, priorityUpTo, declineDuplicates, openIssues, sendRequests }');
    const cap = value.priorityUpTo;
    // High and urgent always come to a person (PRJ-14): a cap above normal is refused, not silently lowered.
    if (cap !== null && cap !== 'low' && cap !== 'normal') fail(`autonomy.priorityUpTo is "low", "normal" or null — ${REQUEST_PRIORITIES.slice(2).join(' and ')} always come to a person`);
    return {
        addItems: flag(value.addItems, 'addItems'),
        assign: flag(value.assign, 'assign'),
        priorityUpTo: cap as PmPriorityCap | null,
        declineDuplicates: flag(value.declineDuplicates, 'declineDuplicates'),
        openIssues: flag(value.openIssues, 'openIssues'),
        sendRequests: flag(value.sendRequests, 'sendRequests')
    };
}

function checkedSummary(value: unknown): PmWeeklySummary {
    if (!isObject(value)) return fail('weeklySummary is { day, time }');
    const day = value.day;
    if (!Number.isInteger(day) || (day as number) < 0 || (day as number) > 6) fail('weeklySummary.day is 0 (Sunday) to 6 (Saturday)');
    const time = value.time;
    if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) fail('weeklySummary.time is HH:MM');
    return { day: day as number, time: time as string };
}

/** `value` as the platform keeps it, or a `PmSpecError` naming what is wrong. */
export function checkedPmPolicy(value: unknown): PmPolicy {
    if (!isObject(value)) return fail('the project manager policy is { senders, autonomy, weeklySummary?, notifyOnMerge }');
    if (!Array.isArray(value.senders)) fail('policy.senders must be a list');
    const senders = value.senders as unknown[];
    if (senders.length > PM_SENDER_RULES_MAX) fail(`policy.senders holds at most ${PM_SENDER_RULES_MAX} rules`);
    const notifyOnMerge = value.notifyOnMerge;
    if (typeof notifyOnMerge !== 'boolean') fail('policy.notifyOnMerge must be true or false');
    return {
        senders: senders.map(checkedRule),
        autonomy: checkedAutonomy(value.autonomy),
        ...(value.weeklySummary !== undefined && value.weeklySummary !== null ? { weeklySummary: checkedSummary(value.weeklySummary) } : {}),
        notifyOnMerge: notifyOnMerge as boolean
    };
}

/** The policy `project` runs under: its stored one when it checks, else `PM_POLICY_DEFAULT`. */
export function pmPolicyOf(project: Pick<ProjectRecord, 'pm'> | undefined): PmPolicy {
    const stored = project?.pm?.policy;
    if (stored === undefined) return PM_POLICY_DEFAULT;
    try {
        return checkedPmPolicy(stored);
    } catch {
        return PM_POLICY_DEFAULT;
    }
}
