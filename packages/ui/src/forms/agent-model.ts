/**
 * `AgentConfig` ⇄ the flat draft an `AgentForm` edits.
 *
 * The draft is what the controls bind to (`model={() => draft.name}`); the
 * config is what the Agent actor stores. `toAgentDraft` / `fromAgentDraft`
 * are inverse on canonical configs, and `agentDraftFromFormData` reads the
 * same draft off a pre-hydration post, so both paths meet in one place.
 *
 * Canonical form (what `fromAgentDraft` emits): a `ToolGrant` omits `mode`
 * when it is `'allow'`; a `SkillRef` omits `version` when empty; `Limits`
 * omits unset keys; `execution.model` / `defaultEnvironmentId` are omitted
 * when blank; per-category approval rules come first, in category order,
 * with ids `category:<name>`, then every other rule unchanged.
 */

import { accountKeyFor, parseAccountKey, type AgentConfig, type AgentId, type ApprovalRule, type EnvironmentId, type Limits, type OfflinePolicy, type SkillRef, type ToolGrant } from '@agentic/core';
import { flag, json, list, number, text } from './form-data.js';

export type ApprovalCategory = NonNullable<ApprovalRule['match']['categories']>[number];
export type ApprovalOutcome = ApprovalRule['outcome'];
export type ToolMode = NonNullable<ToolGrant['mode']>;
export type LimitKey = keyof Limits;

export const APPROVAL_CATEGORIES: readonly ApprovalCategory[] = ['read', 'write', 'execute', 'network', 'destructive'];
export const APPROVAL_OUTCOMES: readonly ApprovalOutcome[] = ['allow', 'ask', 'deny'];
export const TOOL_MODES: readonly ToolMode[] = ['allow', 'ask', 'deny'];
export const OFFLINE_POLICIES: readonly OfflinePolicy[] = ['queue', 'fail', 'fallback-api'];
/** What a turn the machine cut short does next (#368, `ExecutionDefaults.onInterrupt`): `ask` is the default. */
export type OnInterrupt = NonNullable<AgentConfig['execution']['onInterrupt']>;
export const LIMIT_KEYS: readonly LimitKey[] = ['maxTurns', 'maxSteps', 'maxTokens', 'maxCostUsd', 'maxWallMs', 'maxDepth', 'maxConcurrentChildren'];

/** Field names as posted. One place, so the form and the parser cannot drift. */
export const AGENT_FIELDS = {
    name: 'name',
    description: 'description',
    role: 'role',
    instructions: 'instructions',
    skills: 'skills',
    tools: 'tools',
    toolMode: (tool: string) => `tool-mode:${tool}`,
    connectors: 'connectors',
    approval: (category: ApprovalCategory) => `approval:${category}`,
    approvalExtra: 'approval-extra',
    memoryShared: 'memory-shared',
    autoLearn: 'auto-learn',
    runtime: 'runtime',
    account: 'account',
    environment: 'environment',
    workdir: 'workdir',
    model: 'model',
    /** The typed model when the model select says `CUSTOM_MODEL`. */
    modelCustom: 'model-custom',
    offlinePolicy: 'offline-policy',
    onInterrupt: 'on-interrupt',
    limit: (key: LimitKey) => `limit:${key}`,
    collaborateAll: 'collaborate-all',
    collaborators: 'collaborators',
    reason: 'reason'
} as const;

/**
 * A runtime the form offers (#234): the option, plus what the app knows about
 * it — why it cannot run work yet (`hint`, with where to fix that) and the
 * models its plugin names (`models`, the runtime's own `defaultModel` first
 * among equals). Without `models` the model is typed.
 */
export interface RuntimeOption {
    readonly value: string;
    readonly label?: string;
    readonly disabled?: boolean;
    /** What is in the way, in a sentence; absent when the runtime is ready. */
    readonly hint?: string;
    /** Where to fix it — the plugin's page, or where a machine is paired. */
    readonly href?: string;
    readonly hrefLabel?: string;
    readonly models?: readonly string[];
    /** The model a blank choice runs on, named in "Runtime default (…)". */
    readonly defaultModel?: string;
}

/** The model select's value for "type one": never a model id (ids carry no underscores at the start). */
export const CUSTOM_MODEL = '__custom';

/** What the model select shows for a model: blank → the runtime default, a known id → itself, anything else → custom. */
export function modelChoice(model: string, models: readonly string[]): string {
    if (!model) return '';
    return models.includes(model) ? model : CUSTOM_MODEL;
}

export interface AgentDraft {
    name: string;
    description: string;
    role: string;
    instructions: string;
    /** `id` or `id@version`. */
    skills: string[];
    tools: string[];
    toolModes: Record<string, ToolMode>;
    connectors: string[];
    /** `''` = no rule for that category. */
    approvals: Record<ApprovalCategory, ApprovalOutcome | ''>;
    /** Rules the category editor does not own (tool / source matches, scoped rules); carried through untouched. */
    approvalExtra: readonly ApprovalRule[];
    memoryShared: string[];
    autoLearn: boolean;
    runtime: string;
    /** The account the agent runs as (#414), as an account key (`accountKeyFor`); `''` = none, pinned to `defaultEnvironmentId` or unassigned. */
    account: string;
    defaultEnvironmentId: string;
    /** The folder work runs in in `defaultEnvironmentId` (#193); `''` = the environment's first root. */
    defaultWorkdir: string;
    model: string;
    offlinePolicy: OfflinePolicy;
    /** `execution.onInterrupt` (#368): `ask` when the config names none. */
    onInterrupt: OnInterrupt;
    limits: Record<LimitKey, number | null>;
    collaborateAll: boolean;
    collaborators: string[];
    /** Why this version exists (AGT-06); posted with the config, not part of it. */
    reason: string;
}

export type AgentErrorKey = 'name' | 'runtime' | 'offlinePolicy' | `limit:${LimitKey}`;
export type AgentErrors = Partial<Record<AgentErrorKey, string>>;

/** A blank agent on the API runtime — the "new agent" form's starting point. */
export function defaultAgentConfig(): AgentConfig {
    return {
        name: '',
        description: '',
        role: '',
        instructions: '',
        skills: [],
        tools: [],
        connectors: [],
        approvalPolicy: [],
        memoryPolicy: { shared: [], autoLearn: 'lessons' },
        execution: { runtime: 'anthropic-api', limits: {}, offlinePolicy: 'queue' },
        collaborators: 'all'
    };
}

export function encodeSkill(skill: SkillRef): string {
    return skill.version ? `${skill.id}@${skill.version}` : skill.id;
}

/** `@acme/skill@1.2` → `{ id: '@acme/skill', version: '1.2' }`; a leading `@` is part of the id. */
export function decodeSkill(encoded: string): SkillRef {
    const at = encoded.lastIndexOf('@');
    return at > 0 ? { id: encoded.slice(0, at), version: encoded.slice(at + 1) } : { id: encoded };
}

function categoryOf(rule: ApprovalRule): ApprovalCategory | null {
    const { tools, categories, source } = rule.match;
    if (categories?.length !== 1 || tools || source || rule.scope !== undefined) return null;
    const category = categories[0]!;
    return rule.id === `category:${category}` ? category : null;
}

export function toAgentDraft(config: AgentConfig): AgentDraft {
    const approvals = Object.fromEntries(APPROVAL_CATEGORIES.map((c) => [c, ''])) as AgentDraft['approvals'];
    const approvalExtra: ApprovalRule[] = [];
    for (const rule of config.approvalPolicy) {
        const category = categoryOf(rule);
        if (category && approvals[category] === '') approvals[category] = rule.outcome;
        else approvalExtra.push(rule);
    }
    const limits = Object.fromEntries(LIMIT_KEYS.map((k) => [k, config.execution.limits[k] ?? null])) as AgentDraft['limits'];
    return {
        name: config.name,
        description: config.description,
        role: config.role,
        instructions: config.instructions,
        skills: config.skills.map(encodeSkill),
        tools: config.tools.map((t) => t.name),
        toolModes: Object.fromEntries(config.tools.map((t) => [t.name, t.mode ?? 'allow'])),
        connectors: config.connectors.map((c) => c.id),
        approvals,
        approvalExtra,
        memoryShared: [...config.memoryPolicy.shared],
        autoLearn: config.memoryPolicy.autoLearn === 'lessons',
        runtime: config.execution.runtime,
        account: config.execution.account ? accountKeyFor(config.execution.runtime, config.execution.account) : '',
        defaultEnvironmentId: config.execution.defaultEnvironmentId ?? '',
        defaultWorkdir: config.execution.defaultWorkdir ?? '',
        model: config.execution.model ?? '',
        offlinePolicy: config.execution.offlinePolicy,
        onInterrupt: config.execution.onInterrupt ?? 'ask',
        limits,
        collaborateAll: config.collaborators === 'all',
        collaborators: config.collaborators === 'all' ? [] : [...config.collaborators],
        reason: ''
    };
}

export function fromAgentDraft(draft: AgentDraft): AgentConfig {
    const limits: { -readonly [K in LimitKey]?: number } = {};
    for (const key of LIMIT_KEYS) {
        const v = draft.limits[key];
        if (v !== null && v !== undefined) limits[key] = v;
    }
    const approvalPolicy: ApprovalRule[] = [];
    for (const category of APPROVAL_CATEGORIES) {
        const outcome = draft.approvals[category];
        if (outcome) approvalPolicy.push({ id: `category:${category}`, match: { categories: [category] }, outcome });
    }
    approvalPolicy.push(...draft.approvalExtra);
    return {
        name: draft.name.trim(),
        description: draft.description,
        role: draft.role,
        instructions: draft.instructions,
        skills: draft.skills.map(decodeSkill),
        tools: draft.tools.map((name) => {
            const mode = draft.toolModes[name] ?? 'allow';
            return mode === 'allow' ? { name } : { name, mode };
        }),
        connectors: draft.connectors.map((id) => ({ id })),
        approvalPolicy,
        memoryPolicy: { shared: [...draft.memoryShared], autoLearn: draft.autoLearn ? 'lessons' : 'off' },
        execution: {
            runtime: draft.runtime,
            // The account (#414): its key parsed back; a key of another runtime, or no key, binds nothing.
            ...(accountOf(draft) ? { account: accountOf(draft)! } : {}),
            ...(draft.defaultEnvironmentId ? { defaultEnvironmentId: draft.defaultEnvironmentId as EnvironmentId } : {}),
            // A folder only means something in its environment: without one it is dropped.
            ...(draft.defaultEnvironmentId && draft.defaultWorkdir.trim() ? { defaultWorkdir: draft.defaultWorkdir.trim() } : {}),
            ...(draft.model ? { model: draft.model } : {}),
            limits,
            offlinePolicy: draft.offlinePolicy,
            // `ask` is the default: only `auto` is written, so a config that never chose stays as it was.
            ...(draft.onInterrupt === 'auto' ? { onInterrupt: 'auto' as const } : {})
        },
        collaborators: draft.collaborateAll ? 'all' : (draft.collaborators as AgentId[])
    };
}

/** The `AccountRef` a draft's account key names for its runtime, or `undefined`. */
export function accountOf(draft: Pick<AgentDraft, 'account' | 'runtime'>): AgentConfig['execution']['account'] {
    const parsed = draft.account ? parseAccountKey(draft.account) : null;
    return parsed && parsed.runtime === draft.runtime ? parsed.ref : undefined;
}

const isOutcome = (v: string): v is ApprovalOutcome => (APPROVAL_OUTCOMES as readonly string[]).includes(v);
const isMode = (v: string): v is ToolMode => (TOOL_MODES as readonly string[]).includes(v);
const isOffline = (v: string): v is OfflinePolicy => (OFFLINE_POLICIES as readonly string[]).includes(v);

/** The draft a pre-hydration post carries — the same field names the form renders. */
export function agentDraftFromFormData(fd: FormData): AgentDraft {
    const F = AGENT_FIELDS;
    const tools = list(fd, F.tools);
    const approvals = Object.fromEntries(
        APPROVAL_CATEGORIES.map((c) => {
            const v = text(fd, F.approval(c));
            return [c, isOutcome(v) ? v : ''];
        })
    ) as AgentDraft['approvals'];
    const offline = text(fd, F.offlinePolicy);
    const model = text(fd, F.model);
    return {
        name: text(fd, F.name),
        description: text(fd, F.description),
        role: text(fd, F.role),
        instructions: text(fd, F.instructions),
        skills: list(fd, F.skills),
        tools,
        toolModes: Object.fromEntries(
            tools.map((t) => {
                const v = text(fd, F.toolMode(t));
                return [t, isMode(v) ? v : 'allow'];
            })
        ),
        connectors: list(fd, F.connectors),
        approvals,
        approvalExtra: json<ApprovalRule[]>(fd, F.approvalExtra, []),
        memoryShared: list(fd, F.memoryShared),
        autoLearn: flag(fd, F.autoLearn),
        runtime: text(fd, F.runtime),
        account: text(fd, F.account),
        defaultEnvironmentId: text(fd, F.environment),
        defaultWorkdir: text(fd, F.workdir),
        model: model === CUSTOM_MODEL ? text(fd, F.modelCustom).trim() : model,
        offlinePolicy: isOffline(offline) ? offline : 'queue',
        onInterrupt: text(fd, F.onInterrupt) === 'auto' ? 'auto' : 'ask',
        limits: Object.fromEntries(LIMIT_KEYS.map((k) => [k, number(fd, F.limit(k))])) as AgentDraft['limits'],
        collaborateAll: flag(fd, F.collaborateAll),
        collaborators: list(fd, F.collaborators),
        reason: text(fd, F.reason)
    };
}

/** Parse a posted agent form straight to its config (the server-side path). */
export function parseAgentFormData(fd: FormData): { config: AgentConfig; reason: string; errors: AgentErrors } {
    const draft = agentDraftFromFormData(fd);
    return { config: fromAgentDraft(draft), reason: draft.reason, errors: validateAgentDraft(draft) };
}

export const AGENT_NAME_MAX = 80;

const COUNT_LIMITS: readonly LimitKey[] = ['maxTurns', 'maxSteps', 'maxTokens', 'maxWallMs', 'maxDepth', 'maxConcurrentChildren'];

/** Every message the form can show; an empty object means the draft may be submitted. */
export function validateAgentDraft(draft: AgentDraft): AgentErrors {
    const errors: AgentErrors = {};
    const name = draft.name.trim();
    if (!name) errors.name = 'Name is required.';
    else if (name.length > AGENT_NAME_MAX) errors.name = `Name must be at most ${AGENT_NAME_MAX} characters.`;
    if (!draft.runtime.trim()) errors.runtime = 'Choose a runtime.';
    if (!isOffline(draft.offlinePolicy)) errors.offlinePolicy = 'Choose an offline policy.';
    for (const key of LIMIT_KEYS) {
        const v = draft.limits[key];
        if (v === null || v === undefined) continue;
        if (!Number.isFinite(v)) errors[`limit:${key}`] = 'Must be a number.';
        else if (COUNT_LIMITS.includes(key) && (!Number.isInteger(v) || v < 1)) errors[`limit:${key}`] = 'Must be a whole number of at least 1.';
        else if (v < 0) errors[`limit:${key}`] = 'Must not be negative.';
    }
    return errors;
}
