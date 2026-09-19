/**
 * Mock data for the operations routes (#90): machines and their
 * environments, pairing, schedules, plugins, settings, history and usage.
 * Shapes use `@agentic/core` vocabulary where it exists
 * (`EnvironmentDescriptor`, `MachineInfo`, `NotificationKind`); the rest is
 * deliberately local until #36, #42, #48, #44 and #45 wire the actors. The
 * names are the handoff's sample data (`docs/design/HANDOFF.md`): Atlas,
 * Forge, Lint, Scout; alien01, nuc-lab, platform.
 */
import type { AgentHue } from '@agentic/ui';
import type { AgentId, EnvironmentDescriptor, EnvironmentId, MachineId, MachineInfo, MachinePolicy, NotificationKind, PluginManifest, QuotaSnapshot, QuotaWindow, ScheduleId } from '@agentic/core';
import type { Dependents, PluginView } from '@agentic/platform';
import { limitAccountOf, type LimitAccount } from '../pages/usage/limit-accounts';

export interface OpsAgent {
    readonly id: string;
    readonly name: string;
    readonly hue: AgentHue;
    readonly runtime: 'anthropic-api' | 'claude-code';
}

export const opsAgents: readonly OpsAgent[] = [
    { id: 'atlas', name: 'Atlas', hue: 1, runtime: 'anthropic-api' },
    { id: 'forge', name: 'Forge', hue: 2, runtime: 'claude-code' },
    { id: 'lint', name: 'Lint', hue: 3, runtime: 'claude-code' },
    { id: 'scout', name: 'Scout', hue: 4, runtime: 'anthropic-api' }
];

export const opsAgent = (id: string): OpsAgent => opsAgents.find(a => a.id === id) ?? { id, name: id, hue: 1, runtime: 'anthropic-api' };

/* ---------------------------------------------------------------- machines */

export interface OpsMachine extends MachineInfo {
    /** What the OS row prints ("Windows 11"). */
    readonly osLabel: string;
    /** Relative age of the last heartbeat or last sighting, already formatted. */
    readonly seen: string;
    readonly pairedOn: string;
}

export const opsMachines: readonly OpsMachine[] = [
    { id: 'alien01' as MachineId, name: 'alien01', os: 'windows', osLabel: 'Windows 11', daemonVersion: '0.1.0', online: true, lastSeenAt: Date.parse('2026-09-17T14:20:04Z'), seen: '4s ago', pairedOn: '16 Sep' },
    { id: 'nuc-lab' as MachineId, name: 'nuc-lab', os: 'windows', osLabel: 'Windows 11', daemonVersion: '0.1.0', online: false, lastSeenAt: Date.parse('2026-09-17T11:20:00Z'), seen: '3h ago', pairedOn: '12 Sep' }
];

export const opsMachine = (id: string): OpsMachine | undefined => opsMachines.find(m => m.id === id);

/** Ids as the workspace mock names them (`env_alien01_work`), so an agent's environment and the Machines page agree. */
const envId = (machineId: string, name: string): EnvironmentId => `env_${machineId.replace(/-/g, '')}_${name.replace(/-/g, '_')}` as EnvironmentId;

const env = (machineId: string, name: string, account: EnvironmentDescriptor['account'], active: number, max: number, cwdRoots: readonly string[], runtime: EnvironmentDescriptor['runtime'] = 'claude-code'): EnvironmentDescriptor => ({
    id: envId(machineId, name),
    machineId: machineId as MachineId,
    name,
    runtime,
    account,
    cwdRoots,
    concurrency: { active, max },
    isolation: 'config-dir'
});

export const opsEnvironments: readonly EnvironmentDescriptor[] = [
    env('alien01', 'work', { label: 'work', authStatus: 'ok' }, 1, 3, ['C:\\Dev', 'D:\\scratch']),
    env('alien01', 'personal', { label: 'personal', authStatus: 'ok' }, 1, 3, ['C:\\Users\\andy\\src']),
    env('alien01', 'client-acme', { label: 'client-acme', authStatus: 'expired' }, 0, 2, ['C:\\clients\\acme']),
    env('alien01', 'copilot', { label: 'octocat', authStatus: 'ok' }, 0, 2, ['C:\\Dev'], 'copilot-cli'),
    env('alien01', 'codex', { label: 'andy@team', authStatus: 'ok' }, 0, 2, ['C:\\Dev'], 'codex-cli'),
    env('nuc-lab', 'work', { label: 'work', authStatus: 'unknown' }, 0, 2, ['C:\\work'])
];

export const environmentsOf = (machineId: string): readonly EnvironmentDescriptor[] => opsEnvironments.filter(e => e.machineId === machineId);

/**
 * What each sample daemon reports about web management (#239): alien01 lets
 * the page manage environments inside its allowed folders, nuc-lab does not —
 * so both states of the machine page show on mock data.
 */
export const opsMachinePolicies: Readonly<Record<string, MachinePolicy>> = {
    alien01: { webManaged: true, allowedRoots: ['C:\\Dev', 'D:\\scratch', 'C:\\Users\\andy\\src', 'C:\\clients'] },
    'nuc-lab': { webManaged: false, allowedRoots: [] }
};

export const machinePolicyOf = (machineId: string): MachinePolicy | undefined => opsMachinePolicies[machineId];

export const opsEnvironment = (id: string): EnvironmentDescriptor | undefined => opsEnvironments.find(e => e.id === id);

/** Agents that default to an environment, by environment id. */
export const defaultAgentsFor: Readonly<Record<string, readonly string[]>> = {
    'env_alien01_work': ['forge'],
    'env_alien01_personal': ['lint']
};

/** Tasks queued for an environment (held under the agent's offline policy, EXE-12). */
export const queuedFor: Readonly<Record<string, number>> = { 'env_nuclab_work': 1 };

export const queuedOn = (machineId: string): number => environmentsOf(machineId).reduce((n, e) => n + (queuedFor[e.id] ?? 0), 0);

/** The `platform` row: `anthropic-api` runs without any machine. */
export const platformRow = {
    name: 'platform',
    caption: 'anthropic-api · your own key, encrypted at rest · runs without any machine online',
    defaultFor: ['atlas', 'scout'],
    key: 'auth-ok' as const,
    keyLabel: 'KEY OK'
};

export interface OpsSession {
    readonly id: string;
    readonly task: string;
    readonly agentId: string;
    readonly environment: string;
    readonly machineId: string;
    /** A pill status: `waiting` (awaiting approval), `active` (running). */
    readonly status: 'waiting' | 'active';
    readonly age: string;
}

export const opsSessions: readonly OpsSession[] = [
    { id: 's_41aa', task: 'Drawer collapse in shell.css', agentId: 'forge', environment: 'work', machineId: 'alien01', status: 'waiting', age: '14m' },
    { id: 's_41ab', task: 'Review the change', agentId: 'lint', environment: 'personal', machineId: 'alien01', status: 'active', age: '3m' }
];

export const sessionsOn = (machineId: string): readonly OpsSession[] => opsSessions.filter(s => s.machineId === machineId);

export interface DoctorCheck {
    readonly text: string;
    readonly ok: boolean;
    readonly note: string;
}

/** The EXE-07 account-isolation checklist the daemon reports. */
export const doctorChecks: readonly DoctorCheck[] = [
    { text: 'Each environment has its own profile directory', ok: true, note: '3 of 3' },
    { text: "Starting work in one does not change another's login", ok: true, note: 'validated 17 Sep' },
    { text: 'settingSources is empty', ok: true, note: 'ok' },
    { text: 'client-acme can authenticate', ok: false, note: 'token expired' }
];

export const doctorFootnote = 'Validated for Windows. macOS and Linux stay disabled until the same check passes there.';

/* ------------------------------------------------------------------ pairing */

export const pairing = {
    code: 'K7Q2MX',
    /** Seconds left on the code when the page opens; the countdown starts at 10:00. */
    expiresIn: 521,
    install: 'npm i -g agentic-daemon',
    grants: [
        'The machine can accept work for this workspace and report results. Runtime logins stay on the machine. The platform only sees whether each account can authenticate.',
        'Revoke a machine at any time from its page.'
    ]
};

/* ---------------------------------------------------------------- schedules */

export type ScheduleKind = 'reminder' | 'recurring' | 'agent-task';

export interface OpsSchedule {
    readonly id: string;
    readonly kind: ScheduleKind;
    readonly what: string;
    readonly when: string;
    /** Already in the workspace zone; `paused` while disabled. */
    readonly nextRun: string;
    /** `platform` or an environment id; with an agent when an agent runs it. */
    readonly runsOn: { readonly environmentId?: string; readonly agentId?: string };
    readonly enabled: boolean;
}

export const opsSchedules: readonly OpsSchedule[] = [
    { id: 'sch_1', kind: 'reminder', what: 'Call the venue about the field service event', when: 'once', nextRun: 'today 15:00', runsOn: {}, enabled: true },
    { id: 'sch_2', kind: 'recurring', what: 'Weekly summary to inbox', when: 'Thu 17:30', nextRun: 'today 17:30', runsOn: { agentId: 'atlas' }, enabled: true },
    { id: 'sch_3', kind: 'agent-task', what: 'Nightly dependency audit', when: 'daily 02:00', nextRun: 'tomorrow 02:00', runsOn: { environmentId: 'env_nuclab_work', agentId: 'forge' }, enabled: true },
    { id: 'sch_4', kind: 'recurring', what: 'Stand up and stretch', when: 'weekdays 10:30', nextRun: 'paused', runsOn: {}, enabled: false }
];

export const workspaceTimeZone = 'Europe/Stockholm';
/** AST-07: how a recurrence behaves across a daylight-saving change. */
export const dstRule = `Times are ${workspaceTimeZone}. Across daylight saving, 02:00 jobs run once: skipped hours run at 03:00, repeated hours run the first time only.`;

/** The amber line under a schedule bound to an offline environment. */
export function offlinePolicyLine(schedule: OpsSchedule): string | undefined {
    const id = schedule.runsOn.environmentId;
    if (!id) return undefined;
    const env = opsEnvironment(id);
    const machine = env ? opsMachine(env.machineId) : undefined;
    return machine && !machine.online ? `${machine.name} is offline · policy: queue until it returns` : undefined;
}

/* ------------------------------------------------------------------ plugins */

const FIRST_PARTY = { platform: '*', core: '*' } as const;

const manifest = (m: Omit<PluginManifest, 'compat' | 'capabilities'> & { readonly capabilities?: readonly string[] }): PluginManifest => ({ capabilities: [], compat: FIRST_PARTY, ...m });

const builtin = (m: PluginManifest, more: Partial<Pick<PluginView, 'enabled' | 'config' | 'active' | 'grantedPermissions'>> = {}): PluginView => ({
    manifest: m,
    enabled: true,
    config: {},
    grantedPermissions: m.permissions.map(p => p.scope),
    registeredAt: 0,
    updatedAt: 0,
    builtin: true,
    ...more
});

const NOTHING_TO_SET = { type: 'object', properties: {}, additionalProperties: false } as const;

/**
 * The Registry's `overview().plugins` of the mock workspace (#233): the
 * plugins a build ships, under their real ids, plus a connector the
 * workspace added and an A2A server it has not turned on.
 */
export const opsPlugins: readonly PluginView[] = [
    builtin(manifest({
        id: 'anthropic-api', version: '0.1.0', kind: 'runtime', name: 'Anthropic API', capabilities: ['platform-hosted', 'model'],
        description: 'Agents run on the platform against the Anthropic API with your own key.',
        config: { type: 'object', properties: { defaultModel: { type: 'string', title: 'Default model', description: 'The model an agent runs on when its own config names none.', enum: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'], default: 'claude-opus-5' } }, additionalProperties: false },
        secrets: [{ name: 'anthropic-api-key', title: 'Anthropic API key', description: 'A key from console.anthropic.com (sk-ant-…). Stored sealed; opened only to start a session.', required: true }],
        permissions: [{ scope: 'secret:anthropic-api-key', reason: 'Calls the Anthropic API with your key when a session starts.' }]
    }), { config: { defaultModel: 'claude-opus-5' } }),
    builtin(manifest({
        id: 'claude-code', version: '0.1.0', kind: 'runtime', name: 'Claude Code', capabilities: ['daemon-hosted', 'harness', 'usage-limits'],
        description: 'Agents run in Claude Code on a paired machine, signed in with the account of the chosen environment, and each account reports its plan usage limits. Credentials stay on the machine.',
        config: NOTHING_TO_SET,
        permissions: [{ scope: 'machine:*', reason: 'Starts sessions on your paired machines, inside the folders their environments allow.' }]
    })),
    builtin(manifest({
        id: 'copilot-cli', version: '0.1.0', kind: 'runtime', name: 'Copilot CLI', capabilities: ['daemon-hosted', 'harness', 'usage-limits'],
        description: 'Agents run in GitHub Copilot CLI on a paired machine, signed in with the GitHub account of the chosen environment, and each account reports its monthly premium requests. Credentials stay on the machine.',
        config: NOTHING_TO_SET,
        permissions: [{ scope: 'machine:*', reason: 'Starts sessions on your paired machines, inside the folders their environments allow.' }]
    })),
    builtin(manifest({
        id: 'codex-cli', version: '0.1.0', kind: 'runtime', name: 'Codex', capabilities: ['daemon-hosted', 'harness', 'usage-limits'],
        description: 'Agents run in OpenAI Codex on a paired machine, signed in with the ChatGPT account of the chosen environment, and each account reports its plan usage limits. Credentials stay on the machine.',
        config: NOTHING_TO_SET,
        permissions: [{ scope: 'machine:*', reason: 'Starts sessions on your paired machines, inside the folders their environments allow.' }]
    })),
    {
        manifest: manifest({
            id: 'github-mcp', version: '1.2.0', kind: 'connector', name: 'GitHub (MCP)', capabilities: ['tools'],
            description: 'Issues and pull requests as tools, over streamable HTTP.',
            config: { type: 'object', properties: { url: { type: 'string', format: 'uri', title: 'Server URL', default: 'https://api.github.com/mcp' } }, required: ['url'], additionalProperties: false },
            secrets: [{ name: 'github-token', title: 'GitHub token', description: 'A fine-grained token with access to the repositories agents work on.', required: true }],
            permissions: [
                { scope: 'network:api.github.com', reason: 'Reaches the GitHub MCP server.' },
                { scope: 'secret:github-token', reason: 'Signs its requests with your token.' },
                { scope: 'tools:github-mcp', reason: 'Offers its tools to the agents that select it.' }
            ]
        }),
        enabled: true,
        config: { url: 'https://api.github.com/mcp' },
        grantedPermissions: ['network:api.github.com', 'secret:github-token', 'tools:github-mcp'],
        registeredAt: Date.parse('2026-09-12T09:00:00Z'),
        updatedAt: Date.parse('2026-09-12T09:00:00Z'),
        builtin: false
    },
    builtin(manifest({
        id: 'agentic.memory.default', version: '0.1.0', kind: 'memory', name: 'Memory',
        description: 'The default memory: ranked keyword retrieval, conditions, evidence and superseding, with a full export.',
        config: NOTHING_TO_SET,
        permissions: [{ scope: 'memory:read', reason: 'Retrieves memories for a session.' }, { scope: 'memory:write', reason: 'Stores, updates and retires memories.' }]
    }), { active: true }),
    builtin(manifest({
        id: 'agentic.memory.flat', version: '0.1.0', kind: 'memory', name: 'Flat memory',
        description: 'A plain list with substring retrieval. It keeps no conditions, evidence, superseding or expiry — a migration into it reports what is lost.',
        config: NOTHING_TO_SET,
        permissions: [{ scope: 'memory:read', reason: 'Retrieves memories for a session.' }, { scope: 'memory:write', reason: 'Stores, updates and retires memories.' }]
    }), { active: false }),
    builtin(manifest({
        id: 'agentic.learning.default', version: '0.1.0', kind: 'learning', name: 'Learning',
        description: 'Turns corrections into lessons and task outcomes into records. Memory writes are automatic; instruction changes are proposals you review.',
        config: NOTHING_TO_SET,
        permissions: [{ scope: 'memory:read', reason: 'Finds earlier lessons before it writes a new one.' }, { scope: 'memory:write', reason: 'Writes lessons and task records to memory.' }]
    }), { active: true }),
    builtin(manifest({
        id: 'a2a', version: '1.0.0', kind: 'a2a', name: 'A2A server',
        description: 'Expose chosen agents as A2A cards to remote A2A clients.',
        config: { type: 'object', properties: { exposedAgents: { type: 'array', items: { type: 'string' }, title: 'Exposed agents', default: [] } }, additionalProperties: false },
        permissions: []
    }), { enabled: false })
];

/** The Registry's `dependentsAll()` of the mock workspace: one row per plugin. */
export const opsPluginDependents: readonly Dependents[] = [
    { pluginId: 'anthropic-api', agents: [{ id: 'atlas' as AgentId, name: 'Atlas', via: ['runtime'] }, { id: 'scout' as AgentId, name: 'Scout', via: ['runtime'] }, { id: 'forge' as AgentId, name: 'Forge', via: ['fallback'] }], schedules: [] },
    { pluginId: 'claude-code', agents: [{ id: 'forge' as AgentId, name: 'Forge', via: ['runtime'] }, { id: 'lint' as AgentId, name: 'Lint', via: ['runtime'] }], schedules: [{ id: 'sch_audit' as ScheduleId, title: 'Nightly dependency audit', agentId: 'lint' as AgentId }] },
    { pluginId: 'github-mcp', agents: [{ id: 'forge' as AgentId, name: 'Forge', via: ['connector', 'tool'] }], schedules: [] },
    { pluginId: 'agentic.memory.default', agents: [], schedules: [], workspaceWide: true },
    { pluginId: 'agentic.memory.flat', agents: [], schedules: [] },
    { pluginId: 'agentic.learning.default', agents: [], schedules: [], workspaceWide: true },
    { pluginId: 'a2a', agents: [], schedules: [] }
];

/** What `pluginReadiness` reads in the mock workspace: the GitHub token is set, the Anthropic key is not yet. */
export const opsPluginFacts: { readonly secretNames: readonly string[]; readonly hasKek: boolean } = { secretNames: ['github-token'], hasKek: true };

/* ----------------------------------------------------------------- settings */

export interface NotificationRow {
    readonly kind: NotificationKind | 'approval-or-input';
    readonly label: string;
    readonly inbox: boolean;
    readonly push: boolean;
}

export const opsSettings = {
    timeZone: workspaceTimeZone,
    timeZones: ['Europe/Stockholm', 'Europe/London', 'America/New_York', 'Asia/Tokyo', 'UTC'],
    defaultEnvironment: 'platform',
    environmentOptions: [
        { value: 'platform', label: 'platform / anthropic-api / byo-key' },
        { value: 'env_alien01_work', label: 'alien01 / claude-code / work' },
        { value: 'env_alien01_personal', label: 'alien01 / claude-code / personal' }
    ],
    /** Web Push may slip (architecture §12); when it does the column is hidden, not disabled. */
    pushAvailable: true,
    notifications: [
        { kind: 'approval-or-input', label: 'Approval or input needed', inbox: true, push: true },
        { kind: 'reminder', label: 'Reminders', inbox: true, push: true },
        { kind: 'task-failed', label: 'Task failed', inbox: true, push: true },
        { kind: 'task-done', label: 'Task completed', inbox: true, push: false }
    ] as readonly NotificationRow[],
    apiKeys: [{ provider: 'anthropic', masked: 'sk-ant-…9f2c', status: 'auth-ok' as const, label: 'KEY OK' }],
    budgets: { monthly: '$50.00', perTask: '$5.00' },
    retention: { sessionLogs: '90 days', artifacts: '30 days' }
};

/* ------------------------------------------------------------------ history */

export type HistoryKind = 'correction' | 'approval-asked' | 'approval' | 'environment' | 'delegation' | 'interrupted' | 'config' | 'transition';

export interface HistoryEntry {
    readonly id: string;
    /** ISO time in the workspace zone. */
    readonly at: string;
    readonly kind: HistoryKind;
    /** `you` or an agent id. */
    readonly actor: string;
    readonly what: string;
    readonly ref: { readonly label: string; readonly href: string };
}

export const historyFilters = [
    { id: 'all', label: 'All', kinds: undefined },
    { id: 'approvals', label: 'Approvals', kinds: ['approval', 'approval-asked'] },
    { id: 'delegations', label: 'Delegations', kinds: ['delegation'] },
    { id: 'environments', label: 'Environments and folders', kinds: ['environment'] },
    { id: 'transitions', label: 'Transitions', kinds: ['transition'] },
    { id: 'config', label: 'Config changes', kinds: ['config'] }
] as const satisfies readonly { id: string; label: string; kinds?: readonly HistoryKind[] }[];

export type HistoryFilter = (typeof historyFilters)[number]['id'];

export const opsHistory: readonly HistoryEntry[] = [
    { id: 'h1', at: '2026-09-17T14:20:03', kind: 'correction', actor: 'you', what: 'Corrected Forge: check the focus trap after layout changes → lesson stored', ref: { label: 's_41aa', href: '/sessions/s_41aa' } },
    { id: 'h2', at: '2026-09-17T14:09:40', kind: 'approval-asked', actor: 'forge', what: 'Bash git push origin 47-mobile-drawer · rule ask on destructive', ref: { label: 'r_5d01', href: '/sessions/s_41aa' } },
    { id: 'h3', at: '2026-09-17T14:02:12', kind: 'environment', actor: 'forge', what: 'Session opened on alien01 / claude-code / work (agent default)', ref: { label: 's_41aa', href: '/sessions/s_41aa' } },
    { id: 'h4', at: '2026-09-17T14:02:11', kind: 'delegation', actor: 'atlas', what: 'Delegated to Forge · depth 1 · budget split $5.00', ref: { label: 't_8f2c', href: '/tasks/t_8f2c' } },
    { id: 'h5', at: '2026-09-17T14:02:11', kind: 'delegation', actor: 'atlas', what: 'Delegated to Lint · depth 1 · budget split $2.00', ref: { label: 't_8f2d', href: '/tasks/t_8f2d' } },
    { id: 'h6', at: '2026-09-17T13:41:55', kind: 'interrupted', actor: 'atlas', what: 'Turn interrupted by platform restart · not replayed · waiting for Resume', ref: { label: 's_40f7', href: '/sessions/s_40f7' } },
    { id: 'h7', at: '2026-09-17T11:06:20', kind: 'approval', actor: 'you', what: 'Allowed for session: Bash pnpm test * (from phone)', ref: { label: 'r_5c88', href: '/sessions/s_41aa' } },
    { id: 'h8', at: '2026-09-17T09:12:44', kind: 'config', actor: 'you', what: 'Forge v6 → v7 · Added the Verify command rule', ref: { label: 'v7', href: '/agents/forge' } },
    { id: 'h9', at: '2026-09-17T02:00:00', kind: 'transition', actor: 'forge', what: 'Nightly dependency audit queued · nuc-lab offline · policy queue', ref: { label: 't_7e01', href: '/tasks/t_7e01' } },
    { id: 'h10', at: '2026-09-16T17:30:02', kind: 'transition', actor: 'atlas', what: 'Weekly summary completed · verified', ref: { label: 't_7c10', href: '/tasks/t_7c10' } },
    { id: 'h11', at: '2026-09-16T09:04:10', kind: 'config', actor: 'you', what: 'Lint v2 → v3 · Reviewer role, read-only tools', ref: { label: 'v3', href: '/agents/lint' } }
];

/* ------------------------------------------------------------------- quota */

/**
 * Provider limits per account (#270): `alien01 / work` mirrors a real
 * `claude` → `/usage` (19 % session, 76 % week, 80 % Fable week); `nuc-lab`
 * is offline, so its snapshot is hours old and shows stale; the platform's
 * `anthropic-api` reports none, and says why. Times are relative to load.
 */
const QUOTA_AT = Date.now();
const inHours = (h: number) => new Date(QUOTA_AT + h * 3_600_000).toISOString();
const quotaWin = (id: string, label: string, period: QuotaWindow['period'], utilization: number, resetsInHours: number, model?: string): QuotaWindow => ({
    id,
    label,
    period,
    ...(model ? { scope: { model } } : {}),
    utilization,
    unit: 'percent',
    resetsAt: inHours(resetsInHours),
    status: utilization >= 1 ? 'exhausted' : utilization >= 0.8 ? 'warning' : 'ok'
});
const claudeQuota = (environmentId: EnvironmentId, windows: readonly QuotaWindow[], minutesAgo: number): QuotaSnapshot => ({
    sourceId: 'agentic.quota.claude-code',
    runtime: 'claude-code',
    environmentId,
    plan: 'max',
    availability: 'reported',
    windows,
    observedAt: QUOTA_AT - minutesAgo * 60_000,
    via: 'probe'
});

/** Snapshots by environment id; an environment without one has reported nothing yet (`client-acme`: signed out). */
export const opsQuota: Readonly<Record<string, QuotaSnapshot>> = {
    [envId('alien01', 'work')]: claudeQuota(envId('alien01', 'work'), [
        quotaWin('five_hour', 'Current session', 'session', 0.19, 3.2),
        quotaWin('seven_day', 'Current week (all models)', 'week', 0.76, 78),
        quotaWin('seven_day:fable', 'Current week (Fable)', 'week', 0.8, 78, 'Fable')
    ], 2),
    [envId('alien01', 'personal')]: claudeQuota(envId('alien01', 'personal'), [
        quotaWin('five_hour', 'Current session', 'session', 0.42, 1.5),
        quotaWin('seven_day', 'Current week (all models)', 'week', 0.31, 120),
        quotaWin('seven_day:fable', 'Current week (Fable)', 'week', 0.12, 120, 'Fable')
    ], 4),
    [envId('nuc-lab', 'work')]: claudeQuota(envId('nuc-lab', 'work'), [
        quotaWin('five_hour', 'Current session', 'session', 0.05, 0.5),
        quotaWin('seven_day', 'Current week (all models)', 'week', 0.58, 60)
    ], 180),
    // Copilot meters requests per month: premium requests against the plan, chat unlimited.
    [envId('alien01', 'copilot')]: {
        sourceId: 'agentic.quota.copilot-cli',
        runtime: 'copilot-cli',
        environmentId: envId('alien01', 'copilot'),
        availability: 'reported',
        windows: [
            { id: 'premium_interactions', label: 'Premium requests', period: 'month', utilization: 0.42, used: 126, limit: 300, unit: 'requests', resetsAt: inHours(9 * 24), status: 'ok' },
            { id: 'chat', label: 'Chat messages (unlimited)', period: 'month', utilization: null, used: 0, unit: 'requests', resetsAt: inHours(9 * 24), status: 'ok' }
        ],
        observedAt: QUOTA_AT - 3 * 60_000,
        via: 'probe'
    },
    // Codex: a 5-hour and a weekly window, as `codex` → `/status` shows them.
    [envId('alien01', 'codex')]: {
        sourceId: 'agentic.quota.codex-cli',
        runtime: 'codex-cli',
        environmentId: envId('alien01', 'codex'),
        plan: 'team',
        availability: 'reported',
        windows: [quotaWin('primary', 'Current session', 'session', 0.18, 2.5), quotaWin('secondary', 'Current week', 'week', 0.61, 96)],
        observedAt: QUOTA_AT - 60_000,
        via: 'probe'
    }
};

/** The platform's own runtime: no environment, no plan allowance to report. */
export const platformQuota: QuotaSnapshot = {
    sourceId: 'agentic.quota.anthropic-api',
    runtime: 'anthropic-api',
    environmentId: 'env_platform_anthropic_api' as EnvironmentId,
    availability: 'not-reported',
    reason: 'The Anthropic API has per-minute rate limits, not a plan allowance to report',
    windows: [],
    observedAt: QUOTA_AT - 60_000,
    via: 'probe'
};

/** `/usage` Limits and Home's rail: every environment of every machine, then the platform runtime. */
export const opsLimitAccounts = (): readonly LimitAccount[] => [
    ...opsEnvironments.map((env) => {
        const machine = opsMachine(env.machineId);
        return limitAccountOf(env, machine?.name ?? env.machineId, machine?.online ?? false, opsQuota[env.id] ?? null);
    }),
    { key: 'platform', title: 'anthropic-api · your key', caption: 'platform · anthropic-api', snapshot: platformQuota }
];

/* -------------------------------------------------------------------- usage */

export type UsageBy = 'agent' | 'task' | 'turn';
export type DataQuality = 'reported' | 'partly-estimated' | 'not-reported';

export interface UsageRow {
    readonly id: string;
    readonly label: string;
    /** For `agent` rows: the agent's id (tile + runtime); for others, a mono sub-label. */
    readonly agentId?: string;
    readonly sub?: string;
    readonly tasks: number;
    /** `null` = the provider reported nothing (never 0). */
    readonly tokens: number | null;
    readonly costUsd: number | null;
    readonly quality: DataQuality;
}

export const usageStats = [
    { label: 'September spend', value: '$18.42', caption: 'of $50.00 monthly limit', tone: 'live' as const },
    { label: 'Estimated share', value: '$2.10', caption: 'pricing unknown for 1 model', tone: 'needs-you' as const },
    { label: 'Not reported', value: '31 sessions', caption: 'claude-code gives no cost data', tone: 'muted' as const },
    { label: 'Corrections this week', value: '3', caption: 'down from 7 last week', tone: 'live' as const }
];

export const usageDays = { from: '1 Sep', to: '17 Sep', today: '$1.74', values: [0.6, 1.1, 0.8, 1.9, 1.4, 0.2, 0.1, 0.9, 2.1, 1.5, 2.8, 1.4, 0.7, 0.5, 2.3, 3.4, 2.6] };

const agentRows: readonly UsageRow[] = [
    { id: 'atlas', label: 'Atlas', agentId: 'atlas', tasks: 41, tokens: 2_100_000, costUsd: 11.9, quality: 'reported' },
    { id: 'scout', label: 'Scout', agentId: 'scout', tasks: 12, tokens: 1_400_000, costUsd: 6.52, quality: 'partly-estimated' },
    { id: 'forge', label: 'Forge', agentId: 'forge', tasks: 23, tokens: null, costUsd: null, quality: 'not-reported' },
    { id: 'lint', label: 'Lint', agentId: 'lint', tasks: 8, tokens: null, costUsd: null, quality: 'not-reported' }
];

const taskRows: readonly UsageRow[] = [
    { id: 't_8f2c', label: 'Make the drawer collapse below 768 px', sub: 't_8f2c · Forge', tasks: 1, tokens: null, costUsd: null, quality: 'not-reported' },
    { id: 't_7c10', label: 'Weekly summary', sub: 't_7c10 · Atlas', tasks: 1, tokens: 310_000, costUsd: 1.74, quality: 'reported' },
    { id: 't_77b1', label: 'Summarise which A2A clients exist today', sub: 't_77b1 · Scout', tasks: 1, tokens: 220_000, costUsd: 0.98, quality: 'partly-estimated' }
];

const turnRows: readonly UsageRow[] = [
    { id: 'turn_1', label: 'Atlas · turn 14', sub: 's_40f7 · 14:02', tasks: 1, tokens: 12_400, costUsd: 0.07, quality: 'reported' },
    { id: 'turn_2', label: 'Scout · turn 3', sub: 's_3e11 · 13:58', tasks: 1, tokens: 9_800, costUsd: 0.05, quality: 'partly-estimated' },
    { id: 'turn_3', label: 'Forge · turn 9', sub: 's_41aa · 14:09', tasks: 1, tokens: null, costUsd: null, quality: 'not-reported' }
];

export const usageRows: Readonly<Record<UsageBy, readonly UsageRow[]>> = { agent: agentRows, task: taskRows, turn: turnRows };

/** OPS-07: an unreported figure prints `n/a`, never 0; an estimate is prefixed `~`. */
export function money(cost: number | null, quality: DataQuality): string {
    if (cost === null || quality === 'not-reported') return 'n/a';
    const text = `$${cost.toFixed(2)}`;
    return quality === 'partly-estimated' ? `~${text}` : text;
}

export function tokensText(tokens: number | null): string {
    if (tokens === null) return 'n/a';
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
    if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
    return String(tokens);
}
