/**
 * Settings › Project manager (#760, PRJ-14; the PMSettings board): the view model. The manager block edits the
 * project's own manager agent — its name, personality (a preset or custom text) and skills — as a
 * `ProjectManagerPatch` of only what changed (`Workspace.updateProjectManager`, a new agent config version). The
 * policy — who may send requests, keeping you in the loop, what the manager may do without asking — is a `PmPolicy`
 * saved as `ProjectPatch.pmPolicy` through `upsertProject`. Pure: the mock and live pages render the same view.
 */
import { PM_PERSONALITIES, PM_PERSONALITY_MAX, type PmAutonomy, type PmPersonality, type PmPolicy, type PmPriorityCap, type PmSenderRule, type ProjectId, type ProjectManagerSpec } from '@agentic/core';
import { CUSTOM_PERSONALITY, PERSONALITY_SAMPLES } from '../../new/model';

/** The project's manager agent as the page shows it. */
export interface PmAgent {
    readonly id: string;
    readonly name: string;
    /** `execution.runtime` of its config (`anthropic-api` for a manager the platform made). */
    readonly runtime: string;
    /** Read back from its instructions; absent when they carry no personality section. */
    readonly personality?: PmPersonality;
    readonly skills: readonly string[];
}

/** What `updateProjectManager` takes: any of the spec's fields. */
export type ManagerPatch = Partial<ProjectManagerSpec>;

const PERSONALITY_HEADING = '\n## Personality\n\n';

/**
 * The personality in a manager's instructions (`PM_PLAYBOOK`, then `## Personality` and the paragraph): the preset
 * whose instructions it is, else the custom text. `undefined` when there is no personality section.
 */
export function personalityOfInstructions(instructions: string | undefined): PmPersonality | undefined {
    const at = instructions?.lastIndexOf(PERSONALITY_HEADING) ?? -1;
    if (!instructions || at < 0) return undefined;
    const text = instructions.slice(at + PERSONALITY_HEADING.length).trim();
    if (!text) return undefined;
    const preset = PM_PERSONALITIES.find((p) => p.instructions.trim() === text);
    return preset ? { preset: preset.id } : { custom: text };
}

/** The manager editor ("Change"). */
export interface ManagerDraft {
    name: string;
    /** A preset id, or `'custom'` for `custom`. */
    personality: string;
    custom: string;
    skills: string[];
}

export function managerDraftOf(agent: PmAgent | null): ManagerDraft {
    const p = agent?.personality;
    return {
        name: agent?.name ?? '',
        personality: p ? ('preset' in p ? p.preset : CUSTOM_PERSONALITY) : PM_PERSONALITIES[0]!.id,
        custom: p && 'custom' in p ? p.custom : '',
        skills: [...(agent?.skills ?? [])]
    };
}

export type ManagerErrors = Partial<Record<'name' | 'personality', string>>;

export function validateManagerDraft(d: ManagerDraft): ManagerErrors {
    const errors: ManagerErrors = {};
    if (!d.name.trim()) errors.name = 'The project manager needs a name.';
    if (d.personality === CUSTOM_PERSONALITY && !d.custom.trim()) errors.personality = 'Describe how the project manager works, or pick a preset.';
    return errors;
}

const personalityOfDraft = (d: ManagerDraft): PmPersonality =>
    d.personality === CUSTOM_PERSONALITY ? { custom: d.custom.trim().slice(0, PM_PERSONALITY_MAX) } : { preset: d.personality };

const skillsOfDraft = (d: ManagerDraft): string[] => [...new Set(d.skills.map((s) => s.trim()).filter(Boolean))];

/** The whole spec, for a project that has no manager yet (`upsertProject` with `pm`). */
export function managerSpecOf(d: ManagerDraft): ProjectManagerSpec {
    const name = d.name.replace(/\s+/g, ' ').trim();
    return { ...(name ? { name } : {}), personality: personalityOfDraft(d), skills: skillsOfDraft(d).map((id) => ({ id })) };
}

/** Only what the editor changed on `agent`; `null` when nothing did. */
export function managerPatchOf(d: ManagerDraft, agent: PmAgent): ManagerPatch | null {
    const out: { name?: string; personality?: PmPersonality; skills?: { id: string }[] } = {};
    const name = d.name.replace(/\s+/g, ' ').trim();
    if (name && name !== agent.name) out.name = name;
    const personality = personalityOfDraft(d);
    if (JSON.stringify(personality) !== JSON.stringify(agent.personality ?? null)) out.personality = personality;
    const skills = skillsOfDraft(d);
    if (JSON.stringify(skills) !== JSON.stringify(agent.skills)) out.skills = skills.map((id) => ({ id }));
    return Object.keys(out).length ? out : null;
}

/** The preview of how it opens: the preset's sample line, or the first sentences of the custom text. */
export function openingLines(p: PmPersonality | undefined): string {
    if (!p) return '';
    if ('preset' in p) return PERSONALITY_SAMPLES[p.preset] ?? '';
    const text = p.custom.replace(/\s+/g, ' ').trim();
    const sentences = text.match(/[^.!?]+[.!?]*/g) ?? [];
    const lines = sentences.slice(0, 2).join('').trim();
    return lines.length > 160 ? `${lines.slice(0, 159).trimEnd()}…` : lines;
}

/** The personality's label: the preset's, or "Custom". */
export function personalityLabel(p: PmPersonality | undefined): string {
    if (!p) return '—';
    return 'preset' in p ? (PM_PERSONALITIES.find((x) => x.id === p.preset)?.label ?? p.preset) : 'Custom';
}

/** The runtime note: a platform runtime answers with every machine off. */
export function runtimeNote(runtime: string): string {
    return runtime === 'anthropic-api' ? `${runtime} · runs on the platform, so it answers with every machine off` : `${runtime} · runs on a machine; a platform runtime is recommended so it answers with every machine off`;
}

// ---- the policy ----

type AutonomySwitch = Exclude<keyof PmAutonomy, 'priorityUpTo'>;

/** The page's editable copy of a `PmPolicy`, flat so every switch binds one key. */
export interface PolicyDraft {
    /** The rules in order; each one's mode is `allowed[rule.project]`. */
    senders: PmSenderRule[];
    /** By rule project (`'*'` for any other project): `true` → straight to triage, `false` → ask me first. */
    allowed: Record<string, boolean>;
    autonomy: Record<AutonomySwitch, boolean>;
    /** May set priority alone, up to `cap`. */
    priority: boolean;
    cap: PmPriorityCap;
    weekly: boolean;
    /** `'0'` Sunday … `'6'` Saturday. */
    day: string;
    time: string;
    notifyOnMerge: boolean;
}

export const WEEKLY_DEFAULT = { day: 1, time: '08:45' } as const;

export function policyDraftOf(policy: PmPolicy): PolicyDraft {
    const { priorityUpTo, ...switches } = policy.autonomy;
    const senders = policy.senders.map((r) => ({ ...r }));
    return {
        senders: senders.some((r) => r.project === '*') ? senders : [...senders, { project: '*', who: 'any-member', mode: 'ask' }],
        allowed: Object.fromEntries(policy.senders.map((r) => [r.project, r.mode === 'allowed'])),
        autonomy: { ...switches },
        priority: priorityUpTo !== null,
        cap: priorityUpTo ?? 'normal',
        weekly: !!policy.weeklySummary,
        day: String(policy.weeklySummary?.day ?? WEEKLY_DEFAULT.day),
        time: policy.weeklySummary?.time ?? WEEKLY_DEFAULT.time,
        notifyOnMerge: policy.notifyOnMerge
    };
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validatePolicyDraft(d: PolicyDraft): string {
    return d.weekly && !TIME.test(d.time.trim()) ? 'The weekly summary needs a time as HH:MM.' : '';
}

/** The `PmPolicy` the draft saves: the named projects' rules, then the `'*'` rule; the weekly summary only when on. */
export function policyOf(d: PolicyDraft): PmPolicy {
    const mode = (r: PmSenderRule): 'allowed' | 'ask' => (d.allowed[r.project] ? 'allowed' : 'ask');
    const named = d.senders.filter((r) => r.project !== '*');
    const rest = d.senders.find((r) => r.project === '*');
    return {
        senders: [...named, ...(rest ? [rest] : [])].map((r) => ({ ...r, mode: mode(r) })),
        autonomy: { ...d.autonomy, priorityUpTo: d.priority ? d.cap : null },
        ...(d.weekly ? { weeklySummary: { day: Number(d.day), time: d.time.trim() } } : {}),
        notifyOnMerge: d.notifyOnMerge
    };
}

/** Add a rule letting any member of `projectId` send straight to triage (before the `'*'` rule); no-op when it has one. */
export function addSenderProject(d: PolicyDraft, projectId: string): void {
    if (!projectId || projectId === '*' || d.senders.some((r) => r.project === projectId)) return;
    d.allowed = { ...d.allowed, [projectId]: true };
    d.senders = [...d.senders.filter((r) => r.project !== '*'), { project: projectId as ProjectId, who: 'any-member', mode: 'allowed' }, ...d.senders.filter((r) => r.project === '*')];
}

/** Drop a named project's rule: its members then fall under any other project. */
export function removeSenderProject(d: PolicyDraft, projectId: string): void {
    if (projectId === '*') return;
    d.senders = d.senders.filter((r) => r.project !== projectId);
}

/** "Atlas, Forge, Lint and you" / "any member". */
export function whoLabel(who: PmSenderRule['who'], nameOf: (id: string) => string): string {
    if (who === 'any-member') return 'any member';
    const names = [...new Set(who.map((w) => (w.kind === 'agent' ? nameOf(w.agentId) : 'you')))];
    if (names.length <= 1) return names[0] ?? 'nobody';
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The "may do without asking" rows, board order. `priority` is the `priorityUpTo` switch. */
export const AUTONOMY_ROWS: readonly { readonly key: AutonomySwitch | 'priority'; readonly label: string; readonly hint: string }[] = [
    { key: 'addItems', label: 'Add items to the Plan', hint: 'From accepted requests and its own triage' },
    { key: 'assign', label: 'Assign items to members', hint: 'Puts them in queues; agents still claim them' },
    { key: 'priority', label: 'Set priority up to Normal', hint: 'High or urgent always comes to you, because it moves other work' },
    { key: 'declineDuplicates', label: 'Decline duplicates', hint: 'Links the earlier item and tells the sender' },
    { key: 'openIssues', label: 'Open GitHub issues', hint: 'Through the Git feature, when the project has a GitHub origin' },
    { key: 'sendRequests', label: 'Send requests to other projects', hint: 'When this project needs something upstream' }
];

/** A row's label: the priority row names the cap it keeps (a stored `low` stays low). */
export const autonomyLabel = (row: (typeof AUTONOMY_ROWS)[number], d: Pick<PolicyDraft, 'cap'>): string =>
    row.key === 'priority' ? `Set priority up to ${d.cap === 'low' ? 'Low' : 'Normal'}` : row.label;

/** The tools the manager gets, as the board lists them. */
export const MANAGER_TOOLS: readonly { readonly name: string; readonly what: string }[] = [
    { name: 'requests_list', what: 'Incoming and sent requests with state' },
    { name: 'requests_triage', what: 'Propose kind, priority, item and reply' },
    { name: 'requests_resolve', what: 'Accept, ask for more or decline' },
    { name: 'projects_request', what: "Send a request to another project's PM" },
    { name: 'plan_add / plan_assign', what: 'Turn a request into queued work' }
];

export const WEEKDAYS: readonly string[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
