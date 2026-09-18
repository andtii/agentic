/**
 * The live agent pages' view model (#35, #153): pure adapters from what the
 * actors return — `Agent.get()` / `listVersions()` / `listProposals()`, the
 * `TaskIndex` rows, the Memory scope's entries, the Ledger's correction
 * counts — to the `AgentProfile` the roster, header and tabs already render
 * from the mock workspace, plus the patches a form submit persists. Nothing
 * here touches a hook or the DOM.
 */
import { isTerminal, type AgentConfig, type AgentConfigVersion, type MemoryEntry } from '@agentic/core';
import type { EnvironmentParts } from '@agentic/ui';
import type { AgentConfigPatch, AgentView, PendingProposal, TaskIndexRow } from '@agentic/platform';
import type { AgentPresence, AgentProfile, SessionRow } from '../../mock/agents';
import { identityOf } from '../chat/live';

/** The version reason the roster's dialog records when nobody typed one. */
export const CREATED_REASON = 'Created in the web UI';
/** The version reason a config save records when the reason field is blank. */
export const EDITED_REASON = 'Edited in the web UI';

/** What the "New agent" dialog asks for; everything else starts from the platform's defaults. */
export interface NewAgentInput {
    readonly name: string;
    readonly role: string;
}

/**
 * The first version of a new agent: its name and role, on the platform
 * runtime (`anthropic-api`, the demo's target) — an API session fails
 * rather than queues when no key is set, so the failure is visible.
 */
export function newAgentPatch(input: NewAgentInput): AgentConfigPatch {
    const patch: { -readonly [K in keyof AgentConfigPatch]: AgentConfigPatch[K] } = { name: input.name.trim(), execution: { runtime: 'anthropic-api', offlinePolicy: 'fail' } };
    if (input.role.trim()) patch.role = input.role.trim();
    return patch;
}

/** The form's config as a version patch: every top-level field, so a cleared list clears the stored one. */
export function configPatch(config: AgentConfig): AgentConfigPatch {
    return {
        name: config.name,
        description: config.description,
        role: config.role,
        instructions: config.instructions,
        skills: config.skills,
        tools: config.tools,
        connectors: config.connectors,
        approvalPolicy: config.approvalPolicy,
        memoryPolicy: config.memoryPolicy,
        execution: config.execution,
        collaborators: config.collaborators
    };
}

/** What the other actors say about an agent (#153); everything absent reads as idle / empty / zero. */
export interface AgentActivity {
    /** The agent's `TaskIndex` rows (`list({ assignee })`). */
    readonly tasks?: readonly TaskIndexRow[];
    /** The entries of the agent's private memory scope, retired included. */
    readonly memories?: readonly MemoryEntry[];
    /** `Ledger.corrections(agent, week)`, and the same for `what: 'wrong'`. */
    readonly correctionsThisWeek?: number;
    readonly repeatedMistakes?: number;
    /** Tasks in flight that started on a config version older than the current one (AGT-07). */
    readonly activeOnOlder?: number;
    /** The oldest instruction proposal waiting for review (LRN-08). */
    readonly proposal?: PendingProposal;
}

/**
 * `Agent.get()` + `listVersions()` (+ the activity the other actors report)
 * → the profile the tabs render. The hue and environment line follow the chat
 * directory (`identityOf`), so an agent looks the same on every page.
 */
export function profileOf(view: AgentView, versions: readonly AgentConfigVersion[], index: number, activity: AgentActivity = {}): AgentProfile {
    const identity = identityOf(view, index);
    const proposed = activity.proposal ? proposedVersion(activity.proposal, view.configVersion) : undefined;
    return {
        id: view.id,
        hue: identity.hue,
        role: view.config.role,
        presence: presenceOf(activity.tasks ?? []),
        environment: identity.environment,
        config: view.config,
        // Newest first, as the rail lists them.
        versions: [...versions].sort((a, b) => b.version - a.version),
        ...(proposed ? { proposed } : {}),
        activeOnOlder: activity.activeOnOlder ?? 0,
        memories: activity.memories ?? [],
        scopes: [{ scope: view.memoryScope, shared: false }, ...view.config.memoryPolicy.shared.map((scope) => ({ scope, shared: true }))],
        correctionsThisWeek: activity.correctionsThisWeek ?? 0,
        repeatedMistakes: activity.repeatedMistakes ?? 0,
        learning: view.config.memoryPolicy.autoLearn !== 'off'
    };
}

// ---- presence and sessions, from the task index ---------------------------------

/** The rows still in flight. */
export const activeTasks = (rows: readonly TaskIndexRow[]): TaskIndexRow[] => rows.filter((r) => !isTerminal(r.status));

/**
 * An agent's presence from its tasks: waiting on a person (an approval or an
 * input request) beats working; nothing in flight is idle. A task parked on
 * a child, a queue or a budget is still the agent's work in flight — active.
 */
export function presenceOf(rows: readonly TaskIndexRow[]): AgentPresence {
    const active = activeTasks(rows);
    if (active.some((r) => r.status === 'waiting' && (r.wait?.kind === 'approval' || r.wait?.kind === 'input'))) return 'waiting';
    return active.length ? 'active' : 'idle';
}

/** Rows grouped by assignee — the roster reads one index for every card. */
export function tasksByAssignee(rows: readonly TaskIndexRow[]): Record<string, TaskIndexRow[]> {
    const out: Record<string, TaskIndexRow[]> = {};
    for (const r of rows) (out[r.assignee] ??= []).push(r);
    return out;
}

/**
 * The agent's sessions, newest first: every session is opened by the router
 * for a task, so the index rows that carry a `sessionId` are the list. One
 * row per session (a resumed task keeps its session); the status is the
 * task's, the age the task's creation. Sessions past the index cap
 * (`TASK_INDEX_CAP`) are not listed (runbook §10).
 */
export function sessionRowsOf(rows: readonly TaskIndexRow[], environment: EnvironmentParts): SessionRow[] {
    const seen = new Set<string>();
    const out: SessionRow[] = [];
    for (const r of [...rows].sort((a, b) => b.createdAt - a.createdAt)) {
        if (!r.sessionId || seen.has(r.sessionId)) continue;
        seen.add(r.sessionId);
        out.push({ id: r.sessionId, agentId: r.assignee, environment, status: r.status, startedAt: new Date(r.createdAt).toISOString(), turns: 0 });
    }
    return out;
}

// ---- learning: proposals and the week's corrections ------------------------------

/** A pending instruction proposal as the rail's NEEDS REVIEW item: the version an acceptance would record. */
export function proposedVersion(p: PendingProposal, currentVersion: number): AgentConfigVersion {
    const reason = p.proposal.reason.trim();
    const adds = `Adds: “${p.proposal.patch.trim()}”`;
    return { version: currentVersion + 1, at: p.at, by: 'learning', reason: reason ? `${reason} ${adds}` : adds };
}

/** `2026-W38` — the ISO week (UTC) the Ledger tallies corrections under; `isoWeek` of `@agentic/learning`, pinned by a test. */
export function isoWeekOf(at: number): string {
    const d = new Date(at);
    const day = d.getUTCDay() || 7;
    // An ISO week belongs to the year of its Thursday.
    const thursday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 4 - day);
    const year = new Date(thursday).getUTCFullYear();
    const week = Math.ceil(((thursday - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
    return `${year}-W${String(week).padStart(2, '0')}`;
}

/**
 * The UTC `yyyy-mm` months the ISO week of `at` has touched so far: a
 * correction is tallied in the ledger of the month it happened in, so a week
 * across a month boundary is two ledgers.
 */
export function weekMonths(at: number): string[] {
    const d = new Date(at);
    const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() || 7) - 1));
    const month = (t: number): string => new Date(t).toISOString().slice(0, 7);
    return [...new Set([month(monday), month(at)])];
}

/** The learning switch as a config patch: off, or back on (`lessons` when it was off). */
export function learningPatch(config: AgentConfig, on: boolean): AgentConfigPatch {
    const was = config.memoryPolicy.autoLearn;
    return { memoryPolicy: { ...config.memoryPolicy, autoLearn: on ? (was === 'off' ? 'lessons' : was) : 'off' } };
}
