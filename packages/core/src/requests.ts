/**
 * Requests and the project manager (#757, projects redesign #722, PRJ-14/PRJ-15): work moves between projects as
 * requests the receiving project's manager triages, and a policy says what that manager may do without asking a
 * person (docs/design/projects/HANDOFF.md, "Project manager and requests"). Every project gets its own project
 * manager agent with a personality and skills (#784). Types and pure helpers only; the store and the tools live with
 * the platform and runtimes.
 */

import type { SkillRef } from './agent.js';
import type { AgentId, ChatId, ProjectId } from './ids.js';
import type { PlanActor, PlanOption } from './plan.js';
import type { Ref } from './refs.js';

export type RequestState = 'needs-you' | 'triaging' | 'asked-for-more' | 'accepted' | 'declined';
export const REQUEST_STATES: readonly RequestState[] = ['needs-you', 'triaging', 'asked-for-more', 'accepted', 'declined'];

/** What the manager judged a request to be. */
export type RequestKind = 'bug' | 'feature' | 'question' | 'docs' | 'chore' | 'duplicate';
export const REQUEST_KINDS: readonly RequestKind[] = ['bug', 'feature', 'question', 'docs', 'chore', 'duplicate'];

/** Lowest first. High and urgent always come to a person: they move other work. */
export type RequestPriority = 'low' | 'normal' | 'high' | 'urgent';
export const REQUEST_PRIORITIES: readonly RequestPriority[] = ['low', 'normal', 'high', 'urgent'];

/** The highest priority a manager may ever set alone. */
export type PmPriorityCap = Exclude<RequestPriority, 'high' | 'urgent'>;

/** Whether the manager could reproduce the report, and how ("Forge's test fails on signalx main b81e0d2"). */
export interface TriageReproduced {
    readonly ok: boolean;
    readonly note?: string;
}

/** An earlier item that looks alike, and why it is or is not the same ("closed, nested batch; different cause"). */
export interface TriageSimilar {
    readonly ref: Ref;
    readonly note?: string;
}

/** The plan item the manager proposes to add in the receiving project. */
export interface TriageProposedItem {
    readonly title: string;
    /** The phase (`PlanPhase.n`) it goes in; absent → the plan's first open phase. */
    readonly phase?: number;
    readonly assignee?: PlanActor;
    readonly doneWhen: readonly string[];
    /** Put it at the top of the assignee's queue. */
    readonly first?: boolean;
    readonly options?: readonly PlanOption[];
}

/** The manager's triage of one request. */
export interface Triage {
    readonly kind: RequestKind;
    readonly priority: RequestPriority;
    /** Why the priority ("blocks a release in another project"). */
    readonly priorityNote?: string;
    readonly reproduced?: TriageReproduced;
    readonly similar: readonly TriageSimilar[];
    /** For a `duplicate`, the item it duplicates goes in `similar` and no item is added. */
    readonly proposedItem?: TriageProposedItem;
    /** Also open a GitHub issue through the project's git feature. */
    readonly openIssue: boolean;
    /** What the manager will post back to the sender. */
    readonly reply: string;
    /** The "why you:" line when it comes to a person; empty when the manager may act alone. */
    readonly why: string;
}

/** A request from one project (its chat and sender) to another project's manager. Not `Request`, which would shadow the fetch global. */
export interface ProjectRequest {
    /** `req_…`. */
    readonly id: string;
    readonly fromProject: ProjectId;
    readonly fromChat?: ChatId;
    /** Who sent it: the agent that found the need, or a person. */
    readonly sender: PlanActor;
    readonly toProject: ProjectId;
    readonly title: string;
    readonly body: string;
    readonly refs: readonly Ref[];
    readonly state: RequestState;
    readonly triage?: Triage;
    /** The item (`#n` in `toProject`) an accepted request became. */
    readonly resultItem?: number;
    /** Set when declined. */
    readonly declineReason?: string;
    readonly createdAt: number;
    readonly updatedAt: number;
}

/** Who may send requests to this project. `project: '*'` is every project no other rule names. */
export interface PmSenderRule {
    readonly project: ProjectId | '*';
    /** `'any-member'` is any member of that project; otherwise just these senders. */
    readonly who: 'any-member' | readonly PlanActor[];
    /** `allowed` goes straight to triage; `ask` asks a person first. */
    readonly mode: 'allowed' | 'ask';
}

/** What the manager may do without asking a person. */
export interface PmAutonomy {
    readonly addItems: boolean;
    readonly assign: boolean;
    /** The highest priority it may set alone; `null` → none. */
    readonly priorityUpTo: PmPriorityCap | null;
    readonly declineDuplicates: boolean;
    readonly openIssues: boolean;
    readonly sendRequests: boolean;
}

export interface PmWeeklySummary {
    /** 0 Sunday … 6 Saturday. */
    readonly day: number;
    /** `HH:MM`, the workspace's time zone. */
    readonly time: string;
}

export interface PmPolicy {
    readonly senders: readonly PmSenderRule[];
    readonly autonomy: PmAutonomy;
    /** A summary on Home each week, when set. */
    readonly weeklySummary?: PmWeeklySummary;
    /** Tell requesters when their item merges. */
    readonly notifyOnMerge: boolean;
}

/** The policy a project manager starts with: other projects ask first; small, reversible moves are allowed. */
export const PM_POLICY_DEFAULT: PmPolicy = {
    senders: [{ project: '*', who: 'any-member', mode: 'ask' }],
    autonomy: { addItems: true, assign: true, priorityUpTo: 'normal', declineDuplicates: true, openIssues: false, sendRequests: false },
    notifyOnMerge: true,
};

/** The project manager on `ProjectRecord.pm`: its agent and its policy. */
export interface ProjectPm {
    /** The project's manager agent, once one was created from a `ProjectManagerSpec`. */
    readonly agentId?: AgentId;
    readonly policy: PmPolicy;
}

/** A project manager's personality: a preset, or a paragraph written by a person. */
export type PmPersonality = { readonly preset: string } | { readonly custom: string };

/** What `ProjectPatch.pm` takes to create or change the project's manager agent (#784). */
export interface ProjectManagerSpec {
    /** The agent's name; the platform picks one when absent. */
    readonly name?: string;
    readonly personality: PmPersonality;
    readonly skills: readonly SkillRef[];
}

declare module './project.js' {
    interface ProjectRecord {
        /** The project's manager (#757). */
        readonly pm?: ProjectPm;
    }
    interface ProjectPatch {
        /** Create or change the project's manager agent; `null` removes it. */
        readonly pm?: ProjectManagerSpec | null;
        /** Replace the manager's policy (`pm.policy`, #819); the manager agent is kept. Left out → kept. */
        readonly pmPolicy?: PmPolicy;
    }
}

export interface PmPersonalityPreset {
    readonly id: string;
    readonly label: string;
    /** One line for the picker. */
    readonly summary: string;
    /** The persona paragraph that joins the project manager playbook. */
    readonly instructions: string;
}

export const PM_PERSONALITIES: readonly PmPersonalityPreset[] = [
    {
        id: 'calm-organiser',
        label: 'Calm organiser',
        summary: 'Keeps the plan tidy and everyone informed, without fuss.',
        instructions:
            'You are a calm, organised project manager. Keep the plan tidy and current, write short plain updates, and make sure every member knows what is next for them. Prefer steady progress over urgency; raise problems early and without drama.',
    },
    {
        id: 'direct-driver',
        label: 'Direct driver',
        summary: 'Pushes for momentum, cuts scope, says what matters.',
        instructions:
            'You are a direct, delivery-focused project manager. Keep work moving: cut scope when it stalls, unblock people fast, and say plainly what matters and what does not. Be brief; lead with the decision, then the reason.',
    },
    {
        id: 'friendly-coach',
        label: 'Friendly coach',
        summary: 'Warm and encouraging; helps members grow and ask for help.',
        instructions:
            'You are a warm, encouraging project manager. Recognise good work, help members break hard items into steps, and make it easy to ask for help. Stay honest about problems, and frame them as things the team will solve together.',
    },
    {
        id: 'meticulous-reviewer',
        label: 'Meticulous reviewer',
        summary: 'Careful about quality: clear done-when, reproduced bugs, no loose ends.',
        instructions:
            'You are a meticulous, quality-minded project manager. Insist on clear done-when checklists, reproduce bugs before you plan them, link duplicates, and check that finished items really meet their checklist. Be precise and thorough, never pedantic.',
    },
];

/** The most characters of personality text that join the playbook. */
export const PM_PERSONALITY_MAX = 2000;

/**
 * The personality paragraph for `spec`: the preset's instructions or the custom text, trimmed to at most
 * `PM_PERSONALITY_MAX` characters. `undefined` when the preset is unknown or the custom text is empty — refused.
 */
export function pmPersonalityText(spec: Pick<ProjectManagerSpec, 'personality'>): string | undefined {
    const p = spec.personality;
    const text = 'preset' in p ? PM_PERSONALITIES.find((x) => x.id === p.preset)?.instructions : typeof p.custom === 'string' ? p.custom : undefined;
    const trimmed = text?.trim().slice(0, PM_PERSONALITY_MAX).trim();
    return trimmed ? trimmed : undefined;
}

/** The tools of the requests flow (MCP naming `<family>_<op>`): the manager's three, and `projects_request` for any agent. */
export const REQUEST_TOOLS = ['requests_list', 'requests_triage', 'requests_resolve', 'projects_request'] as const;
export type RequestToolName = (typeof REQUEST_TOOLS)[number];

/** Which request tools only read. */
export const REQUEST_READ_TOOLS: readonly RequestToolName[] = ['requests_list'];

/** Why a triage has to come to a person instead of the manager acting on it. */
export type PmAskReason = 'priority' | 'add-items' | 'assign' | 'decline-duplicates' | 'open-issues';

/**
 * Every reason `triage` needs a person under `policy`, empty when the manager may act alone. High or urgent
 * priority always comes to a person, whatever the policy says.
 */
export function needsPersonReasons(triage: Triage, policy: Pick<PmPolicy, 'autonomy'>): PmAskReason[] {
    const a = policy.autonomy;
    const reasons: PmAskReason[] = [];
    const rank = (p: RequestPriority) => REQUEST_PRIORITIES.indexOf(p);
    const cap = a.priorityUpTo === null ? -1 : Math.min(rank(a.priorityUpTo), rank('normal'));
    if (rank(triage.priority) > cap) reasons.push('priority');
    if (triage.kind === 'duplicate') {
        if (!a.declineDuplicates) reasons.push('decline-duplicates');
    } else if (triage.proposedItem) {
        if (!a.addItems) reasons.push('add-items');
        if (triage.proposedItem.assignee && !a.assign) reasons.push('assign');
    }
    if (triage.openIssue && !a.openIssues) reasons.push('open-issues');
    return reasons;
}

/** Whether `triage` has to come to a person under `policy`. */
export function needsPerson(triage: Triage, policy: Pick<PmPolicy, 'autonomy'>): boolean {
    return needsPersonReasons(triage, policy).length > 0;
}

const sameActor = (a: PlanActor, b: PlanActor) => (a.kind === 'agent' ? b.kind === 'agent' && a.agentId === b.agentId : b.kind === 'user' && a.userId === b.userId);

/**
 * How a request from `sender` in `fromProject` is let in: the first rule naming the project whose `who` takes the
 * sender, else the `'*'` rule, else `ask`. `isMember` says whether the sender is a member of `fromProject`.
 */
export function pmSenderMode(policy: Pick<PmPolicy, 'senders'>, fromProject: ProjectId, sender: PlanActor, isMember: boolean): 'allowed' | 'ask' {
    const takes = (r: PmSenderRule) => (r.who === 'any-member' ? isMember : r.who.some((w) => sameActor(w, sender)));
    const rule = policy.senders.find((r) => r.project === fromProject && takes(r)) ?? policy.senders.find((r) => r.project === '*' && takes(r));
    return rule?.mode ?? 'ask';
}
